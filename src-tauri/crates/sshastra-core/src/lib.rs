//! Domain logic for sshastra. This crate must never depend on Tauri: the app
//! crate is a thin IPC bridge on top of it, and everything here is testable
//! with plain `cargo test`.

pub mod credentials;
pub mod files;
mod fs_util;
pub mod hosts;
pub mod known_hosts;
pub mod settings;
pub mod ssh;
pub mod terminal;
