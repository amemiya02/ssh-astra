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

use super::recording::RecordingWriter;
use super::{Result, TerminalError, TerminalEvent, TerminalLogText, TerminalSize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputKind {
    Log,
    Recording,
}

/// State updates sent to the Terminal view in the order each file changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum OutputStatus {
    Active,
    Stopped,
    Failed { message: String },
}

/// The output sideband for one Terminal across its lifetime, including reconnects.
pub struct TerminalOutput {
    host: String,
    notify: Box<dyn Fn(OutputKind, OutputStatus) + Send + Sync>,
    state: Mutex<OutputState>,
    // An idle Terminal does not lock, parse, copy or allocate per output chunk.
    capturing: AtomicBool,
}

struct OutputState {
    auto_directory: Option<PathBuf>,
    log: Option<Box<LogWriter>>,
    recording: Option<Box<RecordingWriter>>,
    size: TerminalSize,
    ended: bool,
}

impl TerminalOutput {
    pub fn new(
        host: impl Into<String>,
        size: TerminalSize,
        auto_directory: Option<PathBuf>,
        notify: impl Fn(OutputKind, OutputStatus) + Send + Sync + 'static,
    ) -> Self {
        let capturing = AtomicBool::new(auto_directory.is_some());
        Self {
            host: host.into(),
            notify: Box::new(notify),
            state: Mutex::new(OutputState {
                auto_directory,
                log: None,
                recording: None,
                size,
                ended: false,
            }),
            capturing,
        }
    }

    /// Taps ordered PTY output before passing the original events to the caller.
    pub fn wrap<F>(self: &Arc<Self>, mut sink: F) -> impl FnMut(TerminalEvent) + Send + 'static
    where
        F: FnMut(TerminalEvent) + Send + 'static,
    {
        let output = Arc::clone(self);
        move |event| {
            output.observe(&event);
            sink(event);
        }
    }

    pub(super) fn activate_auto(&self) {
        self.start_pending(&mut self.lock());
    }

    pub(super) fn start(&self, kind: OutputKind, directory: &Path) -> Result<PathBuf> {
        let mut state = self.lock();
        if state.ended {
            return Err(TerminalError::Io("the Terminal has ended".into()));
        }
        self.start_pending(&mut state);
        match kind {
            OutputKind::Log => Ok(self.start_log(&mut state, directory)?),
            OutputKind::Recording => {
                if let Some(writer) = &state.recording {
                    return Ok(writer.path.clone());
                }
                let writer = RecordingWriter::new(directory, &self.host, state.size)
                    .map_err(TerminalError::Recording)?;
                let path = writer.path.clone();
                state.recording = Some(Box::new(writer));
                self.capturing.store(true, Ordering::Release);
                (self.notify)(kind, OutputStatus::Active);
                Ok(path)
            }
        }
    }

    pub(super) fn stop(&self, kind: OutputKind) -> Result<()> {
        self.finish(&mut self.lock(), kind)
            .map_err(|error| match kind {
                OutputKind::Log => TerminalError::Log(error),
                OutputKind::Recording => TerminalError::Recording(error),
            })
    }

    /// Serialize the accepted resize with captured output. Output triggered by
    /// reflow can arrive as soon as the PTY receives the resize.
    pub(super) fn resize(
        &self,
        size: TerminalSize,
        apply: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        let mut state = self.lock();
        apply()?;
        if !state.ended && size != state.size {
            state.size = size;
            if let Some(writer) = &mut state.recording {
                if let Err(error) = writer.resize(size) {
                    state.recording.take();
                    self.refresh_capturing(&state);
                    self.report_failure(OutputKind::Recording, &error);
                }
            }
        }
        Ok(())
    }

    fn observe(&self, event: &TerminalEvent) {
        if !matches!(event, TerminalEvent::Exit { .. }) && !self.capturing.load(Ordering::Acquire) {
            return;
        }
        let mut state = self.lock();
        self.start_pending(&mut state);
        if matches!(event, TerminalEvent::Exit { .. }) {
            state.ended = true;
            for kind in [OutputKind::Log, OutputKind::Recording] {
                if let Err(error) = self.finish(&mut state, kind) {
                    self.report_failure(kind, &error);
                }
            }
            return;
        }
        if let Some(writer) = &mut state.recording {
            let result = match event {
                TerminalEvent::Output(bytes) => writer.write(bytes),
                TerminalEvent::Connection(_) => writer.finish_stream(),
                _ => return,
            };
            if let Err(error) = result {
                state.recording.take();
                self.refresh_capturing(&state);
                self.report_failure(OutputKind::Recording, &error);
            }
        }
        if let Some(writer) = &mut state.log {
            let result = match event {
                TerminalEvent::Output(bytes) => writer.write(bytes),
                TerminalEvent::Connection(_) => writer.finish_line(true),
                _ => return,
            };
            if let Err(error) = result {
                state.log.take();
                self.refresh_capturing(&state);
                self.report_failure(OutputKind::Log, &error);
            }
        }
    }

    fn start_pending(&self, state: &mut OutputState) {
        if let Some(directory) = state.auto_directory.take() {
            if let Err(error) = self.start_log(state, &directory) {
                self.refresh_capturing(state);
                self.report_failure(OutputKind::Log, &error);
            }
        }
    }

    fn start_log(&self, state: &mut OutputState, directory: &Path) -> io::Result<PathBuf> {
        if let Some(writer) = &state.log {
            return Ok(writer.path.clone());
        }
        let writer = LogWriter::new(directory, &self.host)?;
        let path = writer.path.clone();
        state.log = Some(Box::new(writer));
        self.capturing.store(true, Ordering::Release);
        (self.notify)(OutputKind::Log, OutputStatus::Active);
        Ok(path)
    }

    fn finish(&self, state: &mut OutputState, kind: OutputKind) -> io::Result<()> {
        let outcome = match kind {
            OutputKind::Log => state.log.take().map(|mut writer| writer.finish_line(false)),
            OutputKind::Recording => state
                .recording
                .take()
                .map(|mut writer| writer.finish_stream()),
        };
        self.refresh_capturing(state);
        if let Some(outcome) = outcome {
            (self.notify)(kind, OutputStatus::Stopped);
            outcome?;
        }
        Ok(())
    }

    fn refresh_capturing(&self, state: &OutputState) {
        let capturing = state.log.is_some() || state.recording.is_some();
        self.capturing.store(capturing, Ordering::Release);
    }

    fn report_failure(&self, kind: OutputKind, error: &io::Error) {
        (self.notify)(
            kind,
            OutputStatus::Failed {
                message: error.to_string(),
            },
        );
    }

    fn lock(&self) -> MutexGuard<'_, OutputState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

pub(super) const MAX_OUTPUT_CHUNK: usize = 64 * 1024;

pub(super) fn create_output_file(
    directory: &Path,
    host: &str,
    timestamp: DateTime<Utc>,
    extension: &str,
) -> io::Result<(PathBuf, File)> {
    if !directory.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the Terminal output directory must be an absolute path",
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
    let timestamp = timestamp.format("%Y%m%dT%H%M%SZ");
    let path = directory.join(format!(
        "{host}-{timestamp}-{}.{extension}",
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
    Ok((path, file))
}

struct LogWriter {
    path: PathBuf,
    file: File,
    text: TerminalLogText,
    ready: String,
}

impl LogWriter {
    fn new(directory: &Path, host: &str) -> io::Result<Self> {
        let (path, file) = create_output_file(directory, host, SystemTime::now().into(), "log")?;
        Ok(Self {
            path,
            file,
            text: TerminalLogText::default(),
            ready: String::new(),
        })
    }

    fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        // Bound the scratch buffer even when a producer hands us a large burst.
        for chunk in bytes.chunks(MAX_OUTPUT_CHUNK) {
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
