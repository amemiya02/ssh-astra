//! Brings the running desktop instance forward and retains confirmed-safe destination fields.

mod pending;
mod ssh_link;

use pending::PendingLaunches;
use ssh_link::SshLinkTarget;
use std::ffi::OsStr;
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, WebviewWindow};

/// Start with the desktop URI supplied as argv on Linux and Windows.
pub(super) fn startup() -> PendingLaunches {
    let launches = PendingLaunches::default();
    if let Some(link) = cli_link(std::env::args_os()) {
        launches.forward([link]);
    }
    launches
}

pub(super) fn forward(app: &AppHandle, argv: Vec<String>, _cwd: String) {
    // The system may deliver its scheduled launch after SSH Astra is already running.
    if crate::login_launch::requested(&argv) {
        return;
    }
    if app.state::<PendingLaunches>().forward(cli_link(argv)) {
        schedule_activation(app);
    }
}

fn cli_link(args: impl IntoIterator<Item = impl AsRef<OsStr>>) -> Option<SshLinkTarget> {
    let mut args = args.into_iter().skip(1);
    let candidate = args.next()?;
    if args.next().is_some() {
        return None;
    }
    parse_link(candidate.as_ref().to_str()?)
}

fn parse_link(candidate: &str) -> Option<SshLinkTarget> {
    let local_user = (!candidate.contains('@'))
        .then(|| whoami::username().ok())
        .flatten();
    ssh_link::parse(candidate, local_user.as_deref())
}

#[cfg(target_os = "macos")]
pub(super) fn opened(app: &AppHandle, urls: Vec<tauri::Url>) {
    let links = urls
        .iter()
        .take(pending::MAX_PENDING_LAUNCHES)
        .filter_map(|url| parse_link(url.as_str()))
        .collect::<Vec<_>>();
    if !links.is_empty() && app.state::<PendingLaunches>().forward(links) {
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
    if app.state::<PendingLaunches>().forward([]) {
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
    let Some(window) = crate::windows::show_active(app) else {
        return;
    };
    let label = window.label();
    if app.state::<PendingLaunches>().target_for_activation(label) {
        let _ = app.emit_to(EventTarget::webview_window(label), "ssh-link-pending", ());
    }
}

#[tauri::command]
pub(crate) fn take_ssh_links(
    window: WebviewWindow,
    pending: State<'_, PendingLaunches>,
) -> Vec<SshLinkTarget> {
    pending.take_links(window.label())
}

#[cfg(test)]
mod tests {
    use super::cli_link;

    #[test]
    fn only_a_single_ssh_url_argument_is_a_desktop_link() {
        assert!(cli_link(["sshastra", "ssh://deploy@example.test"]).is_some());
        assert!(cli_link(["sshastra"]).is_none());
        assert!(cli_link(["sshastra", "--other", "ssh://deploy@example.test"]).is_none());
        assert!(cli_link(["sshastra", "https://example.test"]).is_none());
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
