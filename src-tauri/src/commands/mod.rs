//! Tauri commands, one module per domain. Each command is a few lines that
//! translate IPC arguments into a `sshastra-core` call.

pub mod agent;
pub mod clipboard;
pub mod command_history;
pub mod connections;
pub mod credentials;
pub mod diagnostics;
pub mod edit;
pub mod files;
pub mod forwards;
pub mod home;
pub mod hosts;
pub mod known_hosts;
pub mod notifications;
mod session_folder;
pub mod settings;
pub mod snippets;
pub mod terminal;
pub mod transfers;
mod watch;
