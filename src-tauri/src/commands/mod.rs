//! Tauri commands, one module per domain. Each command is a few lines that
//! translate IPC arguments into a `sshastra-core` call.

pub mod credentials;
pub mod files;
pub mod forwards;
pub mod hosts;
pub mod settings;
pub mod terminal;
pub mod transfers;
