use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::{Result, Terminal, TerminalError, TerminalLog, TerminalSize};

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
    log: Option<Arc<TerminalLog>>,
}

impl TerminalRegistry {
    pub fn insert(&self, terminal: Box<dyn Terminal>) -> TerminalId {
        self.insert_open(terminal, None)
    }

    /// Registers the Terminal with the log that already wraps its output sink.
    pub fn insert_logged(&self, terminal: Box<dyn Terminal>, log: Arc<TerminalLog>) -> TerminalId {
        log.activate_auto();
        self.insert_open(terminal, Some(log))
    }

    fn insert_open(&self, input: Box<dyn Terminal>, log: Option<Arc<TerminalLog>>) -> TerminalId {
        let id = TerminalId(self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        self.lock().insert(id, OpenTerminal { input, log });
        id
    }

    pub fn start_log(&self, id: TerminalId, directory: &Path) -> Result<PathBuf> {
        self.log(id)?.start(directory)
    }

    pub fn stop_log(&self, id: TerminalId) -> Result<()> {
        self.log(id)?.stop()
    }

    fn log(&self, id: TerminalId) -> Result<Arc<TerminalLog>> {
        self.lock()
            .get(&id)
            .and_then(|terminal| terminal.log.clone())
            .ok_or(TerminalError::NotFound(id))
    }

    pub fn write(&self, id: TerminalId, data: &[u8]) -> Result<()> {
        self.with(id, |t| t.write(data))
    }

    pub fn resize(&self, id: TerminalId, size: TerminalSize) -> Result<()> {
        self.with(id, |t| t.resize(size))
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
