//! The sshastra desktop app: a thin IPC bridge that exposes `sshastra-core`
//! as Tauri commands and pushes its event streams to the front end through
//! Tauri channels. Domain logic belongs in `sshastra-core`, not here.

mod commands;
mod error;
mod prompts;

use std::sync::Arc;

use sshastra_core::credentials;
use sshastra_core::hosts::HostStore;
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::settings::SettingsStore;
use sshastra_core::ssh::{Agent, ConnectionManager};
use sshastra_core::terminal::TerminalRegistry;
use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

use commands::credentials::Vault;
use commands::forwards::ForwardsState;
use commands::hosts::HostsState;
use commands::settings::SettingsState;
use prompts::PendingPrompts;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Restores the main window's size, position and maximized state, and
        // saves them on exit (`.window-state.json` in the app config dir).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    StateFlags::SIZE
                        | StateFlags::POSITION
                        | StateFlags::MAXIMIZED
                        | StateFlags::FULLSCREEN,
                )
                .build(),
        )
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
            let settings =
                SettingsStore::open(config_dir.join("settings.json")).map_err(Into::into);
            // The system keychain; where there is none (Linux without a
            // Secret Service) nothing is saved and every connect asks.
            let vault = credentials::system_vault();
            app.manage(HostsState::new(hosts));
            app.manage(SettingsState::new(settings));
            app.manage(
                ConnectionManager::new(known_hosts)
                    .with_agent(Agent::System)
                    .with_vault(vault.clone()),
            );
            app.manage(Vault(vault));
            Ok(())
        })
        .manage(TerminalRegistry::default())
        .manage(ForwardsState::default())
        .manage(Arc::new(PendingPrompts::default()))
        .invoke_handler(tauri::generate_handler![
            commands::hosts::hosts_list,
            commands::hosts::host_save,
            commands::hosts::host_delete,
            commands::hosts::host_tree,
            commands::hosts::host_duplicate,
            commands::hosts::host_move,
            commands::hosts::group_create,
            commands::hosts::group_rename,
            commands::hosts::group_delete,
            commands::hosts::group_move,
            commands::hosts::hosts_import_ssh_config,
            commands::forwards::forwards_watch,
            commands::forwards::forward_save,
            commands::forwards::forward_delete,
            commands::forwards::forward_start,
            commands::forwards::forward_stop,
            commands::settings::settings_load,
            commands::settings::settings_set,
            commands::credentials::host_credentials_clear,
            commands::terminal::local_terminal_open,
            commands::terminal::remote_terminal_open,
            commands::terminal::prompt_answer,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::terminal::terminal_reconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running sshastra");
}
