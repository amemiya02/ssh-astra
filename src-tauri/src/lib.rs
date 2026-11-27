//! The sshastra desktop app: a thin IPC bridge that exposes `sshastra-core`
//! as Tauri commands and pushes its event streams to the front end through
//! Tauri channels. Domain logic belongs in `sshastra-core`, not here.

mod commands;
mod diagnostics;
mod error;
mod prompts;

#[cfg(test)]
mod diagnostics_tests;

use std::sync::Arc;
use std::time::Instant;

use sshastra_core::credentials;
use sshastra_core::edit::RemoteEditor;
use sshastra_core::files::{FsRegistry, TransferSettings};
use sshastra_core::hosts::HostStore;
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::settings::SettingsStore;
use sshastra_core::ssh::{Agent, ConnectionManager};
use sshastra_core::terminal::TerminalRegistry;
use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

use commands::connections::ConnectionsState;
use commands::credentials::Vault;
use commands::edit::SystemOpener;
use commands::forwards::ForwardsState;
use commands::home::StartupMeasurement;
use commands::hosts::HostsState;
use commands::settings::SettingsState;
use commands::transfers::TransfersState;
use prompts::PendingPrompts;

// The E2E WebDriver server must never ship.
#[cfg(all(feature = "e2e", not(debug_assertions)))]
compile_error!("the `e2e` feature is for debug builds only");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let start = Instant::now();
    let builder = tauri::Builder::default();
    let builder = if std::env::var_os("SSHASTRA_MEASURE_STARTUP").is_some() {
        builder
            .manage(StartupMeasurement::new(start))
            .append_invoke_initialization_script("window.__sshastraMeasureStartup = true;")
    } else {
        builder
    };
    // Lets the E2E smoke test (`e2e/`) drive the webview over WebDriver.
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder
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
        // Native pickers: export / import files, upload files, the folder a download goes to.
        .plugin(tauri_plugin_dialog::init())
        // In-app updates: `latest.json` of the latest GitHub release
        // (`plugins.updater` in tauri.conf.json), then a relaunch into it.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(not(feature = "e2e"))]
            let log_dir = app.path().app_log_dir()?;
            #[cfg(feature = "e2e")]
            let log_dir = std::env::var_os("SSHASTRA_E2E_HOME")
                .map(|home| std::path::PathBuf::from(home).join("logs"))
                .unwrap_or_else(|| {
                    std::env::temp_dir().join(format!("sshastra-e2e-logs-{}", std::process::id()))
                });
            let logs = diagnostics::Logs::new(log_dir);
            if let Err(error) = logs.install() {
                eprintln!("Could not start application logging: {:?}", error.kind());
            }
            logs.install_crash_hook();
            log::info!("application started version={}", app.package_info().version);
            app.manage(logs);
            let config_dir = app.path().app_config_dir()?;
            let hosts = HostStore::open(config_dir.join("hosts.json")).map_err(Into::into);
            // Shared with the `ssh` command line; without a home directory,
            // fall back to a file of our own.
            let known_hosts = KnownHosts::system_default()
                .unwrap_or_else(|| KnownHosts::new(config_dir.join("known_hosts")));
            let settings =
                SettingsStore::open(config_dir.join("settings.json")).map_err(Into::into);
            if let Ok(store) = &settings {
                app.state::<TransfersState>()
                    .apply(&store.section(TransferSettings::SECTION));
            }
            // The system keychain; where there is none (Linux without a
            // Secret Service) nothing is saved and every connect asks.
            // The E2E build never touches the developer's keychain.
            #[cfg(not(feature = "e2e"))]
            let vault = credentials::system_vault();
            #[cfg(feature = "e2e")]
            let vault: Arc<dyn credentials::CredentialVault> = Arc::new(credentials::NoVault);
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
        .manage(ConnectionsState::default())
        .manage(FsRegistry::default())
        // Temp files of remote edits: a folder per run under
        // $TMPDIR/sshastra-edit (one directory per Host), deleted on exit;
        // the next run deletes what a crashed one left.
        .manage(remote_editor())
        .manage(TransfersState::default())
        .manage(Arc::new(PendingPrompts::default()))
        .invoke_handler(tauri::generate_handler![
            commands::home::home_first_paint,
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
            commands::connections::connections_watch,
            commands::connections::host_connect,
            commands::connections::host_test_connection,
            commands::connections::host_disconnect,
            commands::hosts::hosts_import_ssh_config,
            commands::hosts::hosts_export,
            commands::hosts::hosts_import,
            commands::forwards::forwards_watch,
            commands::forwards::forward_save,
            commands::forwards::forward_delete,
            commands::forwards::forward_start,
            commands::forwards::forward_stop,
            commands::settings::settings_load,
            commands::settings::settings_set,
            commands::diagnostics::diagnostics_event,
            commands::diagnostics::diagnostics_open_logs,
            commands::diagnostics::diagnostics_report,
            commands::credentials::host_credentials_clear,
            commands::terminal::local_terminal_open,
            commands::terminal::remote_terminal_open,
            commands::terminal::prompt_answer,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::terminal::terminal_reconnect,
            commands::terminal::terminal_report_cwd,
            commands::files::files_open,
            commands::files::files_connect,
            commands::files::files_local_open,
            commands::files::files_local_delete,
            commands::files::files_local_open_path,
            commands::files::files_list,
            commands::files::files_create_dir,
            commands::files::files_create_empty,
            commands::files::files_rename,
            commands::files::files_count,
            commands::files::files_folder_size,
            commands::files::files_search_names,
            commands::files::files_cancel_scan,
            commands::files::files_delete,
            commands::files::files_chmod,
            commands::files::files_close,
            commands::edit::edit_open,
            commands::edit::edit_retry,
            commands::edit::edit_close,
            commands::transfers::transfers_watch,
            commands::transfers::transfers_upload,
            commands::transfers::transfers_download,
            commands::transfers::transfer_cancel,
            commands::transfers::transfer_retry,
            commands::transfers::transfer_answer,
            commands::transfers::transfers_remove,
        ])
        .build(tauri::generate_context!())
        .expect("error while building sshastra")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Remote edits' temp files go with the app.
                app.state::<RemoteEditor>().close_all();
            }
        });
}

fn remote_editor() -> RemoteEditor {
    let base = std::env::temp_dir().join("sshastra-edit");
    RemoteEditor::start(&base, Arc::new(SystemOpener)).unwrap_or_else(|e| {
        eprintln!("remote edit temp folder {}: {e}", base.display());
        RemoteEditor::new(
            base.join(format!("{}-unlocked", std::process::id())),
            Arc::new(SystemOpener),
        )
    })
}
