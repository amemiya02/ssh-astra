use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, MutexGuard,
};
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

use super::{Result, TerminalError, TerminalEvent, TerminalLogText};

/// State updates sent to the Terminal view in the order the log changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum TerminalLogStatus {
    Active,
    Stopped,
    Failed { message: String },
}

/// The output sideband for one Terminal. Its lifetime spans all the shells
/// opened by the Terminal's reconnect runner.
pub struct TerminalLog {
    host: String,
    notify: Box<dyn Fn(TerminalLogStatus) + Send + Sync>,
    state: Mutex<LogState>,
    // An idle Terminal does not lock, parse, copy or allocate per output chunk.
    capture: AtomicBool,
}

struct LogState {
    auto_directory: Option<PathBuf>,
    writer: Option<Box<LogWriter>>,
    ended: bool,
}

impl TerminalLog {
    pub fn new(
        host: impl Into<String>,
        auto_directory: Option<PathBuf>,
        notify: impl Fn(TerminalLogStatus) + Send + Sync + 'static,
    ) -> Self {
        let capture = AtomicBool::new(auto_directory.is_some());
        Self {
            host: host.into(),
            notify: Box::new(notify),
            state: Mutex::new(LogState {
                auto_directory,
                writer: None,
                ended: false,
            }),
            capture,
        }
    }

    /// Taps the ordered PTY output before passing the original events to the
    /// caller. Input and non-output events never become log text.
    pub fn wrap<F>(self: &Arc<Self>, mut sink: F) -> impl FnMut(TerminalEvent) + Send + 'static
    where
        F: FnMut(TerminalEvent) + Send + 'static,
    {
        let log = Arc::clone(self);
        move |event| {
            log.observe(&event);
            sink(event);
        }
    }

    pub(super) fn activate_auto(&self) {
        let mut state = self.lock();
        self.start_pending(&mut state);
    }

    pub(super) fn start(&self, directory: &Path) -> Result<PathBuf> {
        let mut state = self.lock();
        if state.ended {
            return Err(TerminalError::Io("the Terminal has ended".into()));
        }
        self.start_pending(&mut state);
        Ok(self.start_writer(&mut state, directory)?)
    }

    pub(super) fn stop(&self) -> Result<()> {
        let mut state = self.lock();
        Ok(self.stop_writer(&mut state)?)
    }

    fn observe(&self, event: &TerminalEvent) {
        if !matches!(event, TerminalEvent::Exit { .. }) && !self.capture.load(Ordering::Acquire) {
            return;
        }
        let mut state = self.lock();
        self.start_pending(&mut state);
        if matches!(event, TerminalEvent::Exit { .. }) {
            state.ended = true;
            if let Err(error) = self.stop_writer(&mut state) {
                self.report_failure(&error);
            }
            return;
        }
        let Some(writer) = &mut state.writer else {
            return;
        };
        let result = match event {
            TerminalEvent::Output(bytes) => writer.write(bytes),
            TerminalEvent::Connection(_) => writer.finish_line(true),
            _ => return,
        };
        if let Err(error) = result {
            state.writer.take();
            self.capture.store(false, Ordering::Release);
            self.report_failure(&error);
        }
    }

    fn start_pending(&self, state: &mut LogState) {
        if let Some(directory) = state.auto_directory.take() {
            if let Err(error) = self.start_writer(state, &directory) {
                self.capture.store(false, Ordering::Release);
                self.report_failure(&error);
            }
        }
    }

    fn start_writer(&self, state: &mut LogState, directory: &Path) -> io::Result<PathBuf> {
        if let Some(writer) = &state.writer {
            return Ok(writer.path.clone());
        }
        let writer = LogWriter::new(directory, &self.host)?;
        let path = writer.path.clone();
        state.writer = Some(Box::new(writer));
        self.capture.store(true, Ordering::Release);
        (self.notify)(TerminalLogStatus::Active);
        Ok(path)
    }

    fn stop_writer(&self, state: &mut LogState) -> io::Result<()> {
        self.capture.store(false, Ordering::Release);
        if let Some(mut writer) = state.writer.take() {
            let outcome = writer.finish_line(false);
            (self.notify)(TerminalLogStatus::Stopped);
            outcome?;
        }
        Ok(())
    }

    fn report_failure(&self, error: &io::Error) {
        (self.notify)(TerminalLogStatus::Failed {
            message: error.to_string(),
        });
    }

    fn lock(&self) -> MutexGuard<'_, LogState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

const MAX_LOG_INPUT_CHUNK: usize = 64 * 1024;

struct LogWriter {
    path: PathBuf,
    file: File,
    text: TerminalLogText,
    ready: String,
}

impl LogWriter {
    fn new(directory: &Path, host: &str) -> io::Result<Self> {
        if !directory.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the Terminal log directory must be an absolute path",
            ));
        }
        fs::create_dir_all(directory)?;
        let host: String = host
            .chars()
            .take(40)
            .map(|ch| {
                if ch.is_alphanumeric() || ch == '_' {
                    ch
                } else {
                    '-'
                }
            })
            .collect();
        let host = host.trim_matches('-');
        let host = if host.is_empty() { "Terminal" } else { host };
        let timestamp = DateTime::<Utc>::from(SystemTime::now()).format("%Y%m%dT%H%M%SZ");
        let path = directory.join(format!(
            "{host}-{timestamp}-{}.log",
            Uuid::new_v4().simple()
        ));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path)?;
        Ok(Self {
            path,
            file,
            text: TerminalLogText::default(),
            ready: String::new(),
        })
    }

    fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        // Bound the scratch buffer even when a producer hands us a large burst.
        for chunk in bytes.chunks(MAX_LOG_INPUT_CHUNK) {
            self.text.feed(chunk, &mut self.ready);
            self.flush_ready()?;
        }
        Ok(())
    }

    fn finish_line(&mut self, newline: bool) -> io::Result<()> {
        self.text.finish(&mut self.ready);
        if newline && !self.ready.is_empty() {
            self.ready.push('\n');
        }
        self.flush_ready()
    }

    fn flush_ready(&mut self) -> io::Result<()> {
        self.file.write_all(self.ready.as_bytes())?;
        self.ready.clear();
        Ok(())
    }
}
