//! Domain logic for sshastra. This crate must never depend on Tauri: the app
//! crate is a thin IPC bridge on top of it, and everything here is testable
//! with plain `cargo test`.

pub mod agent;
pub mod credentials;
pub mod edit;
pub mod files;
pub mod forward;
mod fs_util;
pub mod host_import;
pub mod hosts;
pub mod known_hosts;
pub mod proxy;
pub mod settings;
pub mod snippets;
pub mod ssh;
pub mod ssh_config;
pub mod terminal;
mod wildcard;
