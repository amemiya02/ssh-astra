use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::agent::{bound_metadata, TerminalScreen, TerminalStatus};
use crate::hosts::HostId;
use crate::ssh::BoxFuture;

use super::{
    ConnectionState, OutputKind, Result, Terminal, TerminalError, TerminalEvent, TerminalOutput,
    TerminalSize,
};

/// Identifies an open Terminal across the IPC boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
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

type ScreenReader = dyn Fn(usize) -> BoxFuture<'static, Option<TerminalScreen>> + Send + Sync;

/// The metadata side of an open Terminal on a saved Host, with an optional
/// on-demand reader for the desktop renderer's screen.
pub struct SavedTerminalMetadata {
    pub host: HostId,
    state: Mutex<SavedTerminalState>,
    screen: Option<Box<ScreenReader>>,
}

#[derive(Clone)]
pub struct SavedTerminalState {
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub status: Option<TerminalStatus>,
}

impl SavedTerminalMetadata {
    pub fn new(host: HostId) -> Self {
        Self {
            host,
            screen: None,
            state: Mutex::new(SavedTerminalState {
                title: None,
                cwd: None,
                status: Some(TerminalStatus::Connected),
            }),
        }
    }

    pub fn with_screen_reader(
        mut self,
        read: impl Fn(usize) -> BoxFuture<'static, Option<TerminalScreen>> + Send + Sync + 'static,
    ) -> Self {
        self.screen = Some(Box::new(read));
        self
    }

    pub fn read_screen(&self, lines: usize) -> Option<BoxFuture<'static, Option<TerminalScreen>>> {
        Some(self.screen.as_ref()?(lines))
    }

    pub fn observe(&self, event: &TerminalEvent) {
        match event {
            TerminalEvent::Cwd(cwd) => self.lock().cwd = Some(bound_metadata(cwd.clone(), 4096)),
            TerminalEvent::Connection(connection) => {
                let mut state = self.lock();
                state.status = Some(match connection {
                    ConnectionState::Connected => TerminalStatus::Connected,
                    ConnectionState::Reconnecting { .. } => TerminalStatus::Reconnecting,
                    ConnectionState::Disconnected { .. } => TerminalStatus::Disconnected,
                });
                if state.status != Some(TerminalStatus::Connected) {
                    state.cwd = None;
                }
            }
            TerminalEvent::Exit { .. } => self.lock().status = None,
            _ => {}
        }
    }

    pub fn set_title(&self, title: String) {
        let title = title.trim();
        self.lock().title = (!title.is_empty()).then(|| bound_metadata(title.to_owned(), 512));
    }

    pub fn snapshot(&self) -> SavedTerminalState {
        self.lock().clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, SavedTerminalState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Every open Terminal, local or remote, addressed by [`TerminalId`].
/// Safe to share between threads.
#[derive(Clone, Default)]
pub struct TerminalRegistry(Arc<RegistryState>);

#[derive(Default)]
struct RegistryState {
    next_id: AtomicU64,
    terminals: Mutex<HashMap<TerminalId, OpenTerminal>>,
}

struct OpenTerminal {
    input: Box<dyn Terminal>,
    output: Option<Arc<TerminalOutput>>,
    saved: Option<Arc<SavedTerminalMetadata>>,
}

impl TerminalRegistry {
    pub fn insert(&self, terminal: Box<dyn Terminal>) -> TerminalId {
        self.insert_open(terminal, None, None)
    }

    /// Registers the Terminal with the sideband that already wraps its output sink.
    pub fn insert_with_output(
        &self,
        terminal: Box<dyn Terminal>,
        output: Arc<TerminalOutput>,
    ) -> TerminalId {
        self.insert_with_metadata(terminal, output, None)
    }

    pub fn insert_with_metadata(
        &self,
        terminal: Box<dyn Terminal>,
        output: Arc<TerminalOutput>,
        saved: Option<Arc<SavedTerminalMetadata>>,
    ) -> TerminalId {
        output.activate_auto();
        self.insert_open(terminal, Some(output), saved)
    }

    pub fn saved_terminals(&self) -> Vec<(TerminalId, Arc<SavedTerminalMetadata>)> {
        self.lock()
            .iter()
            .filter_map(|(id, terminal)| Some((*id, terminal.saved.as_ref()?.clone())))
            .collect()
    }

    pub fn saved_terminal(&self, id: TerminalId) -> Option<Arc<SavedTerminalMetadata>> {
        self.lock().get(&id)?.saved.clone()
    }

    pub fn set_title(&self, id: TerminalId, title: String) {
        if let Some(saved) = self.saved_terminal(id) {
            saved.set_title(title);
        }
    }

    fn insert_open(
        &self,
        input: Box<dyn Terminal>,
        output: Option<Arc<TerminalOutput>>,
        saved: Option<Arc<SavedTerminalMetadata>>,
    ) -> TerminalId {
        let id = TerminalId(self.0.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        self.lock().insert(
            id,
            OpenTerminal {
                input,
                output,
                saved,
            },
        );
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

    pub fn connection(&self, id: TerminalId) -> Result<Option<(u64, Arc<crate::ssh::Connection>)>> {
        self.with(id, |terminal| Ok(terminal.connection()))
    }

    pub fn write_for_connection(&self, id: TerminalId, generation: u64, data: &[u8]) -> Result<()> {
        self.with(id, |terminal| {
            terminal.write_for_connection(generation, data)
        })
    }

    pub fn follow_file_directory(&self, id: TerminalId, prompt_id: u64, path: &str) -> Result<()> {
        self.with(id, |terminal| {
            terminal.follow_file_directory(prompt_id, path)
        })
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

    /// Gives each eligible open Terminal one attempt when the app gains focus
    /// or the system wakes.
    pub fn reconnect_disconnected(&self) {
        for terminal in self.lock().values_mut() {
            terminal.input.reconnect_disconnected();
        }
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
        self.0
            .terminals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
