//! The sshastra desktop app: a thin IPC bridge that exposes `sshastra-core`
//! as Tauri commands and pushes its event streams to the front end through
//! Tauri channels. Domain logic belongs in `sshastra-core`, not here.

mod agent_transport;
mod commands;
mod diagnostics;
mod error;
#[cfg(any(windows, target_os = "macos", test))]
mod file_drag;
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
mod launch;
#[cfg(target_os = "macos")]
mod macos_menu;
mod prompts;
#[cfg(desktop)]
mod quit;
mod terminal_handoff;
#[cfg(desktop)]
mod tray;
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
mod wake;
mod windows;

#[cfg(test)]
mod diagnostics_tests;

use std::sync::Arc;
use std::time::{Instant, SystemTime};

use sshastra_core::agent::{AgentActivityLog, AgentSettings};
use sshastra_core::credentials;
use sshastra_core::edit::RemoteEditor;
use sshastra_core::files::{FsRegistry, TransferSettings};
use sshastra_core::hosts::HostStore;
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::settings::SettingsStore;
use sshastra_core::snippets::SnippetStore;
use sshastra_core::ssh::{Agent, ConnectionManager, ConnectionSettings};
use sshastra_core::terminal::{CommandHistory, TerminalRegistry};
use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

pub use agent_transport::run_stdio as run_agent_stdio;
use agent_transport::AgentService;

use commands::agent::{DesktopAgent, PendingReviews, PendingScreens};
use commands::clipboard::ClipboardImages;
use commands::connections::{ConnectionsState, TemporaryHosts};
use commands::credentials::Vault;
use commands::edit::SystemOpener;
use commands::forwards::ForwardsState;
use commands::home::StartupMeasurement;
use commands::hosts::HostsState;
use commands::settings::SettingsState;
use commands::snippets::SnippetsState;
use commands::ssh_config_export::{OpenSshSettings, OpenSshSync};
use commands::terminal::TerminalOutputDirectory;
use commands::transfers::TransfersState;

// The E2E WebDriver server must never ship.
#[cfg(all(feature = "e2e", not(debug_assertions)))]
compile_error!("the `e2e` feature is for debug builds only");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let start = Instant::now();
    let context = tauri::generate_context!();
    #[cfg(all(
        feature = "e2e",
        any(windows, target_os = "macos", target_os = "linux")
    ))]
    let context = launch::e2e_context(context);
    let builder = tauri::Builder::default();
    #[cfg(any(windows, target_os = "macos"))]
    let builder =
        builder.append_invoke_initialization_script("window.__sshastraFilePromises = true;");
    // Secondary launches hand off their arguments before other plugins start.
    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    let builder = builder
        .manage(launch::startup())
        .plugin(tauri_plugin_single_instance::init(launch::forward));
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
    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_notification::init());
    #[cfg(desktop)]
    let builder = builder.menu(quit::menu).on_menu_event(quit::on_menu_event);
    #[cfg(target_os = "macos")]
    let builder = builder.on_menu_event(macos_menu::on_menu_event);
    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    let mut wake_listener = None;
    builder
        // Restores each Window's size, position and maximized state, and
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
            #[cfg(target_os = "macos")]
            file_drag::capture_mouse_events();
            app.manage(ForwardsState::new(app.handle()));
            #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
            commands::notifications::listen(app.handle())?;
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
            let terminal_output_directory = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| config_dir.clone())
                .join("terminal-logs");
            app.manage(TerminalOutputDirectory(terminal_output_directory));
            app.manage(CommandHistory::new(config_dir.join("command-history")));
            let hosts = HostStore::open(config_dir.join("hosts.json")).map_err(Into::into);
            // Shared with the `ssh` command line; without a home directory,
            // fall back to a file of our own.
            let known_hosts = KnownHosts::system_default()
                .unwrap_or_else(|| KnownHosts::new(config_dir.join("known_hosts")));
            app.manage(known_hosts.clone());
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
            let open_ssh_settings = settings
                .as_ref()
                .map(|settings| settings.section::<OpenSshSettings>(OpenSshSettings::SECTION))
                .unwrap_or_default();
            let connection_settings = settings
                .as_ref()
                .map(|settings| settings.section::<ConnectionSettings>(ConnectionSettings::SECTION))
                .unwrap_or_default();
            #[cfg(not(feature = "e2e"))]
            let home = app.path().home_dir().ok();
            #[cfg(feature = "e2e")]
            let home = std::env::var_os("SSHASTRA_E2E_HOME").map(std::path::PathBuf::from);
            let settings = SettingsState::new(settings);
            let open_ssh = OpenSshSync::new(
                home,
                open_ssh_settings,
                connection_settings,
                settings.changes(),
            );
            let hosts_available = hosts.is_ok();
            if !hosts_available {
                open_ssh.unavailable_hosts();
            }
            let hosts = HostsState::new(hosts, open_ssh);
            if hosts_available {
                OpenSshSync::sync_at_startup(hosts.clone());
            }
            let agent_activity = Arc::new(AgentActivityLog::new(config_dir.join("agent-activity")));
            if agent_activity.prune(SystemTime::now()).is_err() {
                log::warn!("Could not expire old Agent access activity");
            }
            let agent_service = AgentService::new(
                DesktopAgent::new(
                    app.handle().clone(),
                    hosts.clone(),
                    app.state::<TerminalRegistry>().inner().clone(),
                ),
                Arc::clone(&agent_activity),
            );
            let _ = settings.with(|store| {
                let agent: AgentSettings = store.section(AgentSettings::SECTION);
                if agent.enabled && agent_service.apply(true, || Ok(())).is_err() {
                    log::warn!("Could not start the local Agent access service");
                }
                Ok(())
            });
            app.manage(agent_service);
            app.manage(agent_activity);
            app.manage(hosts);
            app.manage(SnippetsState::new(
                SnippetStore::open(config_dir.join("snippets.json")).map_err(Into::into),
            ));
            app.manage(settings);
            let transfers = app.state::<TransfersState>().queue();
            app.manage(
                ConnectionManager::new(known_hosts)
                    .with_agent(Agent::System)
                    .with_vault(vault.clone())
                    .with_connection_listener(move |host, live| {
                        transfers.connection_restored(host, live);
                    }),
            );
            app.manage(Vault(vault));
            // Each primary instance owns one scratch directory for remote edits.
            app.manage(remote_editor());
            #[cfg(desktop)]
            tray::setup(app.handle());
            windows::restore(app)?;
            Ok(())
        })
        .manage(windows::Windows::default())
        .manage(TerminalRegistry::default())
        .manage(ClipboardImages::default())
        .manage(ConnectionsState::default())
        .manage(TemporaryHosts::default())
        .manage(FsRegistry::default())
        .manage(TransfersState::default())
        .manage(Arc::new(PendingScreens::default()))
        .manage(Arc::new(PendingReviews::default()))
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Focused(true) => {
                windows::focused(window.app_handle(), window.label());
                window.state::<TerminalRegistry>().reconnect_disconnected();
            }
            tauri::WindowEvent::Destroyed => {
                windows::destroyed(window.app_handle(), window.label())
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            windows::window_new,
            windows::tab_move::window_prepare_tab_move,
            windows::tab_move::window_open_tab_move,
            windows::tab_move::window_incoming_tab_move,
            windows::tab_move::window_stage_moved_terminal,
            windows::tab_move::window_complete_tab_move,
            windows::tab_move::window_cancel_tab_move,
            windows::window_try_close,
            windows::window_startup_workspaces,
            windows::window_settings_saved,
            #[cfg(desktop)]
            tray::tray_update,
            #[cfg(desktop)]
            quit::quit_application,
            #[cfg(target_os = "macos")]
            macos_menu::macos_menu_set,
            #[cfg(desktop)]
            quit::quit_menu_localize,
            #[cfg(desktop)]
            quit::quit_live_connection_count,
            commands::home::home_first_paint,
            commands::snippets::snippets_list,
            commands::snippets::snippet_save,
            commands::snippets::snippet_delete,
            commands::snippets::snippets_export,
            commands::snippets::snippets_import,
            commands::hosts::hosts_list,
            commands::hosts::host_save,
            commands::hosts::host_delete,
            commands::hosts::host_bookmark_add,
            commands::hosts::host_bookmark_rename,
            commands::hosts::host_bookmark_delete,
            commands::hosts::host_tree,
            commands::hosts::host_tree_watch,
            commands::hosts::host_duplicate,
            commands::hosts::host_move,
            commands::hosts::hosts_batch_move,
            commands::hosts::hosts_batch_tag,
            commands::hosts::hosts_batch_delete,
            commands::hosts::group_create,
            commands::hosts::group_rename,
            commands::hosts::group_delete,
            commands::hosts::group_move,
            #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
            launch::take_ssh_links,
            commands::connections::connections_watch,
            commands::connections::host_connect,
            commands::connections::host_test_connection,
            commands::connections::host_redetect_os,
            commands::connections::host_disconnect,
            commands::connections::temporary_host_create,
            commands::connections::temporary_host_save,
            commands::connections::temporary_host_forget,
            commands::hosts::hosts_import_source,
            commands::hosts::hosts_export,
            commands::hosts::hosts_import,
            commands::forwards::forwards_watch,
            commands::forwards::forward_save,
            commands::forwards::forward_delete,
            commands::forwards::forward_start,
            commands::forwards::forward_stop,
            commands::settings::settings_load,
            commands::settings::settings_watch,
            commands::settings::settings_set,
            commands::ssh_config_export::ssh_config_export_preview,
            commands::ssh_config_export::ssh_config_export_cancel,
            commands::ssh_config_export::ssh_config_export_enable,
            commands::ssh_config_export::ssh_config_export_disable,
            commands::ssh_config_export::ssh_config_export_refresh,
            commands::ssh_config_export::ssh_config_sync_import,
            commands::agent::agent_activity_list,
            commands::agent::agent_activity_clear,
            commands::command_history::command_history_list,
            commands::command_history::command_history_clear,
            commands::known_hosts::known_hosts_list,
            commands::known_hosts::known_hosts_reveal,
            commands::notifications::notification_show,
            commands::notifications::notification_request_attention,
            commands::diagnostics::diagnostics_event,
            commands::diagnostics::diagnostics_open_logs,
            commands::diagnostics::diagnostics_report,
            commands::credentials::host_credentials_clear,
            commands::credentials::global_proxy_password_clear,
            commands::terminal::local_terminal_shells,
            commands::terminal::local_terminal_open,
            commands::terminal::local_terminal_wsl_paths,
            commands::terminal::remote_terminal_open,
            commands::terminal::prompt_answer,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::terminal::terminal_set_title,
            commands::terminal::terminal_latency_start,
            commands::terminal::terminal_latency_stop,
            commands::resources::terminal_resources_start,
            commands::resources::terminal_resources_set_interval,
            commands::resources::terminal_resources_stop,
            commands::agent::terminal_agent_screen,
            commands::agent::review::terminal_agent_review_answer,
            commands::terminal::terminal_log_start,
            commands::terminal::terminal_log_stop,
            commands::terminal::terminal_recording_start,
            commands::terminal::terminal_recording_stop,
            commands::terminal::terminal_reconnect,
            commands::terminal::terminal_report_cwd,
            commands::terminal::terminal_follow_file_directory,
            commands::clipboard::terminal_save_clipboard_image,
            commands::files::files_open,
            commands::files::files_connect,
            commands::files::files_local_open,
            commands::files::files_local_delete,
            commands::files::files_local_open_path,
            commands::files::files_list,
            #[cfg(any(windows, target_os = "macos"))]
            commands::files::files_wait_for_drag_exit,
            #[cfg(any(windows, target_os = "macos"))]
            commands::files::files_cancel_drag_exit,
            #[cfg(any(windows, target_os = "macos"))]
            commands::files::files_drag_out,
            commands::files::files_remote_home,
            commands::files::files_create_dir,
            commands::files::files_create_empty,
            commands::files::files_rename,
            commands::files::files_compress,
            commands::files::files_extract_archive,
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
            commands::transfers::transfers_copy_remote,
            commands::transfers::transfer_cancel,
            commands::transfers::transfer_pause,
            commands::transfers::transfer_resume,
            commands::transfers::transfer_retry,
            commands::transfers::transfer_answer,
            commands::transfers::transfers_remove,
            commands::transfers::transfer_reveal_download,
        ])
        .build(context)
        .expect("error while building sshastra")
        .run(move |app, event| {
            match event {
                #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
                tauri::RunEvent::Ready => {
                    launch::ready(app);
                    wake_listener = wake::Listener::start(app.clone());
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => launch::opened(app, urls),
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => launch::reopen(app),
                tauri::RunEvent::Exit => {
                    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
                    drop(wake_listener.take());
                    app.state::<AgentService>().stop();
                    // Remote edits and pasted images' temp files go with the app.
                    app.state::<RemoteEditor>().close_all();
                    app.state::<ClipboardImages>().close();
                }
                _ => {}
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
