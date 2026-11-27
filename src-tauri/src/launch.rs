//! Brings the running desktop instance forward and retains its forwarded argv.

mod pending;

pub(super) use pending::PendingLaunches;
use tauri::{AppHandle, Manager};

pub(super) fn forward(app: &AppHandle, argv: Vec<String>, cwd: String) {
    if app.state::<PendingLaunches>().forward(argv, cwd) {
        schedule_activation(app);
    }
}

pub(super) fn ready(app: &AppHandle) {
    if app.state::<PendingLaunches>().ready() {
        activate_window(app);
    }
}

#[cfg(target_os = "macos")]
pub(super) fn reopen(app: &AppHandle) {
    // Finder and the Dock can reopen the app without starting another process.
    if app.state::<PendingLaunches>().reopen() {
        schedule_activation(app);
    }
}

fn schedule_activation(app: &AppHandle) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if handle.state::<PendingLaunches>().take_activation() {
            activate_window(&handle);
        }
    }) {
        app.state::<PendingLaunches>().take_activation();
        log::debug!("could not schedule window activation: {error}");
    }
}

fn activate_window(app: &AppHandle) {
    let Some(window) = crate::windows::active(app) else {
        return;
    };
    #[cfg(target_os = "linux")]
    let result = {
        use gtk::prelude::GtkWindowExt;

        // GTK presents a hidden or minimized window in one request. Tauri's
        // individual show and unminimize requests are queued on Linux.
        window.gtk_window().map(|window| window.present())
    };
    #[cfg(not(target_os = "linux"))]
    let result = (|| {
        #[cfg(target_os = "macos")]
        app.show()?;
        window.unminimize()?;
        window.show()?;
        window.set_focus()
    })();
    if let Err(error) = result {
        log::debug!("could not activate the existing window: {error}");
    }
}

#[cfg(feature = "e2e")]
pub(super) fn e2e_context(mut context: tauri::Context<tauri::Wry>) -> tauri::Context<tauri::Wry> {
    use std::hash::{DefaultHasher, Hash, Hasher};
    use std::path::PathBuf;
    use tauri::utils::config::AppDirectoriesOverride;

    let config = context.config_mut();
    let home = std::env::var_os("SSHASTRA_E2E_HOME").map(PathBuf::from);
    let mut namespace = DefaultHasher::new();
    if let Some(home) = home {
        home.hash(&mut namespace);
        // Keep the settings, Hosts and window state at the path seeded by the E2E harness.
        let relative_config = if cfg!(target_os = "macos") {
            "Library/Application Support"
        } else if cfg!(windows) {
            "AppData/Roaming"
        } else {
            ".config"
        };
        let directory = home.join(relative_config).join(&config.identifier);
        config.app.app_directories_override = Some(AppDirectoriesOverride::Root(directory));
    } else {
        // An unsandboxed debug binary must still never forward to the installed app.
        std::process::id().hash(&mut namespace);
    }
    // A restart with the same sandbox uses the same single-instance endpoint.
    config.identifier = format!("{}.e2e.s{:016x}", config.identifier, namespace.finish());
    context
}
