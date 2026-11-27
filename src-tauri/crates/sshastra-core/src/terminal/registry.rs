use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::{OutputKind, Result, Terminal, TerminalError, TerminalOutput, TerminalSize};

/// Identifies an open Terminal across the IPC boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TerminalId(u64);

impl From<u64> for TerminalId {
    fn from(raw: u64) -> Self {
        Self(raw)
    }
}

impl fmt::Display for TerminalId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Every open Terminal, local or remote, addressed by [`TerminalId`].
/// Safe to share between threads.
#[derive(Default)]
pub struct TerminalRegistry {
    next_id: AtomicU64,
    terminals: Mutex<HashMap<TerminalId, OpenTerminal>>,
}

struct OpenTerminal {
    input: Box<dyn Terminal>,
    output: Option<Arc<TerminalOutput>>,
}

impl TerminalRegistry {
    pub fn insert(&self, terminal: Box<dyn Terminal>) -> TerminalId {
        self.insert_open(terminal, None)
    }

    /// Registers the Terminal with the sideband that already wraps its output sink.
    pub fn insert_with_output(
        &self,
        terminal: Box<dyn Terminal>,
        output: Arc<TerminalOutput>,
    ) -> TerminalId {
        output.activate_auto();
        self.insert_open(terminal, Some(output))
    }

    fn insert_open(
        &self,
        input: Box<dyn Terminal>,
        output: Option<Arc<TerminalOutput>>,
    ) -> TerminalId {
        let id = TerminalId(self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        self.lock().insert(id, OpenTerminal { input, output });
        id
    }

    pub fn start_log(&self, id: TerminalId, directory: &Path) -> Result<PathBuf> {
        self.output(id)?.start(OutputKind::Log, directory)
    }

    pub fn stop_log(&self, id: TerminalId) -> Result<()> {
        self.output(id)?.stop(OutputKind::Log)
    }

    pub fn start_recording(&self, id: TerminalId, directory: &Path) -> Result<PathBuf> {
        self.output(id)?.start(OutputKind::Recording, directory)
    }

    pub fn stop_recording(&self, id: TerminalId) -> Result<()> {
        self.output(id)?.stop(OutputKind::Recording)
    }

    fn output(&self, id: TerminalId) -> Result<Arc<TerminalOutput>> {
        self.lock()
            .get(&id)
            .and_then(|terminal| terminal.output.clone())
            .ok_or(TerminalError::NotFound(id))
    }

    pub fn write(&self, id: TerminalId, data: &[u8]) -> Result<()> {
        self.with(id, |t| t.write(data))
    }

    pub fn resize(&self, id: TerminalId, size: TerminalSize) -> Result<()> {
        let output = self
            .lock()
            .get(&id)
            .ok_or(TerminalError::NotFound(id))?
            .output
            .clone();
        // Capture I/O must not hold the registry lock for unrelated Terminals.
        let apply = || self.with(id, |terminal| terminal.resize(size));
        match output {
            Some(output) => output.resize(size, apply),
            None => apply(),
        }
    }

    /// Retries a remote Terminal's dropped Connection now.
    pub fn reconnect(&self, id: TerminalId) -> Result<()> {
        self.with(id, |t| t.reconnect())
    }

    /// Closes the Terminal and forgets it.
    pub fn close(&self, id: TerminalId) -> Result<()> {
        let mut terminal = self.lock().remove(&id).ok_or(TerminalError::NotFound(id))?;
        terminal.input.close()
    }

    fn with<T>(&self, id: TerminalId, f: impl FnOnce(&mut dyn Terminal) -> Result<T>) -> Result<T> {
        let mut terminals = self.lock();
        let terminal = terminals.get_mut(&id).ok_or(TerminalError::NotFound(id))?;
        f(terminal.input.as_mut())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<TerminalId, OpenTerminal>> {
        // A panic while holding the lock leaves the map itself intact.
        self.terminals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
