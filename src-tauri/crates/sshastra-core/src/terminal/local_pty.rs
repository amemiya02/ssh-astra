use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use super::local_cwd::LocalCwdReader;
use super::{Result, Terminal, TerminalError, TerminalEvent, TerminalSize};

const READ_BUFFER: usize = 64 * 1024;

/// The program a [`LocalPty`] runs.
#[derive(Debug, Clone, Default)]
pub struct ShellCommand {
    /// `None` means the user's default shell (`$SHELL` as a login shell on
    /// Unix, `%ComSpec%` on Windows).
    program: Option<OsString>,
    args: Vec<OsString>,
    cwd: Option<PathBuf>,
    env: Vec<(OsString, OsString)>,
}

impl ShellCommand {
    pub fn new(program: impl Into<OsString>) -> Self {
        Self {
            program: Some(program.into()),
            ..Self::default()
        }
    }

    /// The user's own shell, configured for an xterm-compatible front end.
    pub fn default_shell() -> Self {
        Self::default().with_xterm_env()
    }

    pub(super) fn with_xterm_env(self) -> Self {
        self.env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    pub fn cwd(mut self, dir: impl Into<PathBuf>) -> Self {
        self.cwd = Some(dir.into());
        self
    }

    fn to_builder(&self) -> CommandBuilder {
        let mut builder = match &self.program {
            Some(program) => {
                let mut b = CommandBuilder::new(program);
                b.args(&self.args);
                b
            }
            None => CommandBuilder::new_default_prog(),
        };
        if let Some(cwd) = &self.cwd {
            builder.cwd(cwd);
        }
        for (key, value) in &self.env {
            builder.env(key, value);
        }
        builder
    }
}

/// A shell on the user's own machine, behind a pseudo-terminal: the engine of
/// a Local terminal.
///
/// Output is pushed to the event sink from a background thread as soon as the
/// shell produces it. On macOS and Linux the reader also reports changes to
/// the shell process's working directory.
pub struct LocalPty {
    shell_program: String,
    writer: Box<dyn Write + Send>,
    /// Shared with the waiter thread, which drops it once the shell exits (on
    /// Windows the output pipe only reaches EOF after that).
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl LocalPty {
    pub fn spawn<F>(command: ShellCommand, size: TerminalSize, mut sink: F) -> Result<Self>
    where
        F: FnMut(TerminalEvent) + Send + 'static,
    {
        let pair = native_pty_system()
            .openpty(pty_size(size))
            .map_err(spawn_err)?;
        let builder = command.to_builder();
        let program = builder
            .get_argv()
            .first()
            .cloned()
            .unwrap_or_else(|| builder.get_shell().into());
        let shell_program = Path::new(&program)
            .file_name()
            .unwrap_or(&program)
            .to_string_lossy()
            .into_owned();
        let mut child = pair.slave.spawn_command(builder).map_err(spawn_err)?;
        // Only the child may hold the slave end, or the reader never sees EOF.
        drop(pair.slave);

        let killer = child.clone_killer();
        let mut reader = OutputReader::new(pair.master.as_ref(), child.process_id())?;
        let writer = pair.master.take_writer().map_err(spawn_err)?;
        let master = Arc::new(Mutex::new(Some(pair.master)));

        let reader_thread = thread::Builder::new()
            .name("local-pty-reader".into())
            .spawn(move || {
                let mut buf = vec![0u8; READ_BUFFER];
                loop {
                    match reader.read(&mut buf, &mut sink) {
                        // EOF, or EIO on Linux once the shell side is closed.
                        Ok(0) | Err(_) => break,
                        Ok(n) => sink(TerminalEvent::Output(buf[..n].to_vec())),
                    }
                }
                sink
            })
            .map_err(spawn_err)?;

        let master_for_waiter = Arc::clone(&master);
        thread::Builder::new()
            .name("local-pty-waiter".into())
            .spawn(move || {
                let code = child.wait().ok().map(|status| status.exit_code());
                master_for_waiter.lock().map(|mut m| m.take()).ok();
                // Exit is emitted only after every byte of output was delivered.
                if let Ok(mut sink) = reader_thread.join() {
                    sink(TerminalEvent::Exit { code });
                }
            })
            .map_err(spawn_err)?;

        Ok(Self {
            shell_program,
            writer,
            master,
            killer,
        })
    }

    /// The executable name selected by the command builder for this PTY.
    pub fn shell_program(&self) -> &str {
        &self.shell_program
    }
}

enum OutputReader {
    Plain(Box<dyn Read + Send>),
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    WithCwd(LocalCwdReader),
}

impl OutputReader {
    fn new(master: &dyn MasterPty, _pid: Option<u32>) -> Result<Self> {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if let Some(pid) = _pid {
            if let Some(reader) = LocalCwdReader::new(master, pid).map_err(spawn_err)? {
                return Ok(Self::WithCwd(reader));
            }
        }
        Ok(Self::Plain(master.try_clone_reader().map_err(spawn_err)?))
    }

    fn read(
        &mut self,
        buf: &mut [u8],
        _sink: &mut impl FnMut(TerminalEvent),
    ) -> std::io::Result<usize> {
        match self {
            Self::Plain(reader) => reader.read(buf),
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            Self::WithCwd(reader) => reader.read(buf, _sink),
        }
    }
}

impl Terminal for LocalPty {
    fn write(&mut self, data: &[u8]) -> Result<()> {
        self.writer
            .write_all(data)
            .and_then(|()| self.writer.flush())
            .map_err(|e| TerminalError::Io(e.to_string()))
    }

    fn resize(&mut self, size: TerminalSize) -> Result<()> {
        let master = self
            .master
            .lock()
            .map_err(|e| TerminalError::Io(e.to_string()))?;
        match master.as_ref() {
            Some(master) => master
                .resize(pty_size(size))
                .map_err(|e| TerminalError::Io(e.to_string())),
            // The shell already exited; nothing left to reflow.
            None => Ok(()),
        }
    }

    fn close(&mut self) -> Result<()> {
        // Killing an already-exited shell is not an error worth reporting.
        let _ = self.killer.kill();
        Ok(())
    }
}

impl Drop for LocalPty {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn pty_size(size: TerminalSize) -> PtySize {
    PtySize {
        cols: size.cols,
        rows: size.rows,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn spawn_err(e: impl std::fmt::Display) -> TerminalError {
    TerminalError::Spawn(e.to_string())
}
