//! Terminals: one interactive shell, local (a [`LocalPty`]) or remote (an
//! `ssh::RemoteTerminal`, a shell channel over a Connection). Both implement [`Terminal`], so the
//! IPC layer and the UI treat them the same way.

mod local_pty;
mod registry;

pub use local_pty::{LocalPty, ShellCommand};
pub use registry::{TerminalId, TerminalRegistry};

use serde::{Deserialize, Serialize};

/// Terminal grid size in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

/// What a Terminal pushes out. Output events arrive in order, and `Exit` is
/// always the last event: no output follows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalEvent {
    /// Raw bytes from the shell. May split UTF-8 sequences and escape codes.
    Output(Vec<u8>),
    /// A remote Terminal's Connection dropped, is being reopened, or is back
    /// (with a new shell). Local terminals never send it.
    Connection(ConnectionState),
    /// The shell ended. `code` is `None` when it was not available.
    Exit { code: Option<u32> },
}

/// Where a remote Terminal stands after its Connection dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ConnectionState {
    /// Back, running a new shell (the old one's processes are gone).
    Connected,
    /// Disconnected; try `attempt` of `attempts` is waiting or under way.
    Reconnecting { attempt: u32, attempts: u32 },
    /// Disconnected, and no more automatic tries: only
    /// [`Terminal::reconnect`] tries again. `reason` is the last failure.
    Disconnected { reason: String },
}

#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("failed to start the shell: {0}")]
    Spawn(String),
    #[error("terminal I/O failed: {0}")]
    Io(String),
    #[error("no such terminal: {0}")]
    NotFound(TerminalId),
}

pub type Result<T, E = TerminalError> = std::result::Result<T, E>;

/// The input side of a Terminal. Output is delivered through the event sink
/// given when the Terminal was started.
pub trait Terminal: Send {
    /// Sends keystrokes / pasted bytes to the shell.
    fn write(&mut self, data: &[u8]) -> Result<()>;
    /// Tells the shell the grid size changed so programs (vim, htop) reflow.
    fn resize(&mut self, size: TerminalSize) -> Result<()>;
    /// Ends the shell. An `Exit` event still follows.
    fn close(&mut self) -> Result<()>;
    /// Tries the Connection again now, if it is down. Nothing to do for
    /// Terminals without one.
    fn reconnect(&mut self) -> Result<()> {
        Ok(())
    }
}
