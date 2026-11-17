//! The sshastra desktop app: a thin IPC bridge that exposes `sshastra-core`
//! as Tauri commands and pushes its event streams to the front end through
//! Tauri channels. Domain logic belongs in `sshastra-core`, not here.

mod commands;
mod error;
mod prompts;

use std::sync::Arc;

use sshastra_core::hosts::HostStore;
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{Agent, ConnectionManager};
use sshastra_core::terminal::TerminalRegistry;
use tauri::Manager;

use commands::hosts::HostsState;
use prompts::PendingPrompts;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Terminal links open in the browser; copy on select / paste use the system clipboard.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let hosts = HostStore::open(config_dir.join("hosts.json")).map_err(Into::into);
            // Shared with the `ssh` command line; without a home directory,
            // fall back to a file of our own.
            let known_hosts = KnownHosts::system_default()
                .unwrap_or_else(|| KnownHosts::new(config_dir.join("known_hosts")));
            app.manage(HostsState::new(hosts));
            app.manage(ConnectionManager::new(known_hosts).with_agent(Agent::System));
            Ok(())
        })
        .manage(TerminalRegistry::default())
        .manage(Arc::new(PendingPrompts::default()))
        .invoke_handler(tauri::generate_handler![
            commands::hosts::hosts_list,
            commands::hosts::host_save,
            commands::hosts::host_delete,
            commands::terminal::local_terminal_open,
            commands::terminal::remote_terminal_open,
            commands::terminal::prompt_answer,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running sshastra");
}
