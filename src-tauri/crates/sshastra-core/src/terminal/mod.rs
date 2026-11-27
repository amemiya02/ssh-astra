//! Terminals: one interactive shell, local (a [`LocalPty`]) or remote (an
//! `ssh::RemoteTerminal`, a shell channel over a Connection). Both implement [`Terminal`], so the
//! IPC layer and the UI treat them the same way.

mod command_history;
mod encoding;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod local_cwd;
mod local_pty;
mod local_shells;
mod log_text;
mod output;
mod recording;
mod registry;
mod shell_integration;

pub(crate) use encoding::OutputDecoder;
pub use command_history::CommandHistory;
pub use encoding::{TerminalBackspace, TerminalCharset};
pub use local_pty::{LocalPty, ShellCommand};
pub use local_shells::{local_shell_command, local_shells, local_wsl_paths, LocalShell};
pub use log_text::TerminalLogText;
pub use output::{OutputKind, OutputStatus, TerminalOutput};
pub use registry::{SavedTerminalMetadata, TerminalId, TerminalRegistry};
pub use shell_integration::{CwdParser, ShellOutput, Shown, INJECTION, REPORT_CWD};

use serde::{Deserialize, Serialize};

/// The `terminal` section of the settings file, as the core reads it (the UI
/// keeps its other terminal preferences there too).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalSettings {
    /// Type the ShellIntegration hook into new remote shells.
    pub shell_integration: bool,
    /// Keep command lines reported by Shell integration for saved Hosts.
    pub command_history: bool,
    /// Write Terminal logs automatically for newly opened Terminals.
    pub auto_log: bool,
    /// Where to save Terminal logs and Recordings. None uses the app directory.
    pub log_directory: Option<std::path::PathBuf>,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            shell_integration: true,
            command_history: false,
            auto_log: false,
            log_directory: None,
        }
    }
}

impl TerminalSettings {
    /// The settings file section this is read from.
    pub const SECTION: &'static str = "terminal";
}

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
    /// Screen bytes, with legacy remote text transcoded to UTF-8. Chunks may
    /// split UTF-8 sequences and escape codes.
    Output(Vec<u8>),
    /// A remote Terminal's Connection dropped, is being reopened, or is back
    /// (with a new shell). Local terminals never send it.
    Connection(ConnectionState),
    /// The shell's current directory, read from the local process on macOS/Linux
    /// or reported by the remote shell (Shell integration or OSC 7).
    Cwd(String),
    /// Prompt or command state from an interactive shell with Shell integration.
    ShellIntegration(ShellIntegrationEvent),
    /// The shell ended. `code` is `None` when it was not available.
    Exit { code: Option<u32> },
}

/// Shell integration status for the current shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellIntegrationStatus {
    Available,
    Disabled,
    Unsupported,
    TimedOut,
}

/// The ordered Shell integration events sent over the Terminal Channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ShellIntegrationEvent {
    Availability {
        status: ShellIntegrationStatus,
    },
    PromptStart {
        /// Identifies one prompt in this Terminal, even across reconnections.
        prompt_id: u64,
    },
    /// The command line can be unavailable when the shell omits it from history.
    CommandStart {
        command_line: Option<String>,
    },
    CommandEnd {
        exit_code: u8,
    },
}

/// Where a remote Terminal stands after its Connection dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConnectionState {
    /// Back, running a new shell (the old one's processes are gone).
    Connected,
    /// Disconnected; try `attempt` of `attempts` is waiting or under way.
    Reconnecting { attempt: u32, attempts: u32 },
    /// Disconnected, with the automatic attempts exhausted or stopped.
    /// `reason` is the last failure.
    Disconnected {
        reason: String,
        /// True once per lost Connection when the transport itself fails to reconnect.
        report_reconnect_failure: bool,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("failed to start the shell: {0}")]
    Spawn(String),
    #[error("terminal I/O failed: {0}")]
    Io(String),
    #[error("Terminal log I/O failed: {0}")]
    Log(#[from] std::io::Error),
    #[error("Recording I/O failed: {0}")]
    Recording(std::io::Error),
    #[error("no such terminal: {0}")]
    NotFound(TerminalId),
}

pub type Result<T, E = TerminalError> = std::result::Result<T, E>;

/// The input side of a Terminal. Output is delivered through the event sink
/// given when the Terminal was started.
pub trait Terminal: Send {
    /// Sends keystrokes / pasted bytes to the shell.
    fn write(&mut self, data: &[u8]) -> Result<()>;
    /// The running remote shell's transport and generation, if any.
    fn connection(&self) -> Option<(u64, std::sync::Arc<crate::ssh::Connection>)> {
        None
    }
    /// Sends input only to the captured generation of a remote shell.
    fn write_for_connection(&mut self, _generation: u64, _data: &[u8]) -> Result<()> {
        Err(TerminalError::Io("the remote shell has changed".into()))
    }
    /// Follows a File panel only while the observed remote prompt is still idle.
    fn follow_file_directory(&mut self, _prompt_id: u64, _path: &str) -> Result<()> {
        Ok(())
    }
    /// Tells the shell the grid size changed so programs (vim, htop) reflow.
    fn resize(&mut self, size: TerminalSize) -> Result<()>;
    /// Ends the shell. An `Exit` event still follows.
    fn close(&mut self) -> Result<()>;
    /// Tries the Connection again now, if it is down. Nothing to do for
    /// Terminals without one.
    fn reconnect(&mut self) -> Result<()> {
        Ok(())
    }
    /// Requests one extra attempt on focus or wake, if the Connection is idle after
    /// a transient failure.
    fn reconnect_disconnected(&mut self) {}
}
