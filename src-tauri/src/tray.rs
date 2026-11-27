//! Native tray actions and the ability to recover a hidden Window.

#[cfg(target_os = "linux")]
mod linux;

use std::sync::Mutex;

use serde::Deserialize;
use serde_json::Value;
use sshastra_core::forward::ForwardStatus;
use sshastra_core::hosts::HostId;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow};

use crate::commands::{forwards::ForwardsState, hosts::HostsState, settings::SettingsState};
use crate::{quit, windows};

const SHOW: &str = "tray-show-window";
const QUIT: &str = "tray-quit";
const HOST_PREFIX: &str = "tray-host:";
const COUNT: &str = "{count}";

struct Tray {
    show: MenuItem<tauri::Wry>,
    recent: Submenu<tauri::Wry>,
    forwards: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
    content: Mutex<MenuContent>,
}

#[derive(Default)]
struct MenuContent {
    labels: Option<TrayLabels>,
    recent_hosts: Vec<(HostId, String)>,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrayLabels {
    show_window: String,
    recent_hosts: String,
    running_forwards: String,
    quit: String,
}

pub(crate) fn setup(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    if !linux::indicator_library_available() {
        log::debug!("AppIndicator library unavailable");
        return;
    }
    if let Err(error) = build(app) {
        log::warn!("Could not create the system tray icon: {error}");
    }
}

fn build(app: &AppHandle) -> tauri::Result<()> {
    let icon = app
        .default_window_icon()
        .ok_or_else(|| std::io::Error::other("The app icon is missing"))?;
    let show = MenuItem::with_id(app, SHOW, "Show Window", true, None::<&str>)?;
    let recent = Submenu::new(app, "Recent Hosts", false)?;
    let forwards = MenuItem::new(app, "Running Port forwards: 0", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "Quit SSH Astra", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &recent, &forwards, &separator, &quit])?;
    TrayIconBuilder::with_id("sshastra")
        .icon(icon.clone())
        .tooltip("SSH Astra")
        .menu(&menu)
        .on_menu_event(on_menu_event)
        .build(app)?;
    app.manage(Tray {
        show,
        recent,
        forwards,
        quit,
        content: Mutex::default(),
    });
    Ok(())
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        SHOW => {
            windows::show_active(app);
        }
        QUIT => quit::request(app),
        id => {
            let Some(id) = id.strip_prefix(HOST_PREFIX) else {
                return;
            };
            let host = HostId::from(id.to_owned());
            let saved = app
                .state::<HostsState>()
                .with(|store| Ok(store.get(&host).is_some()))
                .unwrap_or(false);
            if saved {
                if let Some(window) = windows::show_active(app) {
                    if let Err(error) = app.emit_to(
                        EventTarget::webview_window(window.label()),
                        "tray-open-host",
                        host,
                    ) {
                        log::warn!("Could not open a recent Host from the tray: {error}");
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub(crate) fn tray_update(
    app: AppHandle,
    labels: TrayLabels,
    recent_hosts: Vec<HostId>,
) -> Result<(), String> {
    update_menu(&app, labels, recent_hosts).map_err(|error| error.to_string())
}

fn update_menu(app: &AppHandle, labels: TrayLabels, ids: Vec<HostId>) -> tauri::Result<()> {
    let Some(tray) = app.try_state::<Tray>() else {
        return Ok(());
    };
    let recent_hosts = app
        .state::<HostsState>()
        .with(|store| {
            Ok(ids
                .into_iter()
                .filter_map(|id| store.get(&id).map(|host| (id, host.name.clone())))
                .take(20)
                .collect::<Vec<_>>())
        })
        .unwrap_or_default();
    let mut content = tray.content.lock().unwrap();
    if content.labels.as_ref() != Some(&labels) {
        tray.show.set_text(&labels.show_window)?;
        tray.recent.set_text(&labels.recent_hosts)?;
        tray.quit.set_text(&labels.quit)?;
        tray.forwards.set_text(forwards_label(app, &labels))?;
        content.labels = Some(labels);
    }
    // Mutate the existing submenu so the AppIndicator menu stays installed on Linux.
    if recent_hosts != content.recent_hosts {
        let items = recent_hosts
            .iter()
            .map(|(id, name)| {
                let text: String = name.chars().filter(|c| !c.is_control()).collect();
                MenuItem::with_id(
                    app,
                    format!("{HOST_PREFIX}{id}"),
                    text.replace('&', "&&"),
                    true,
                    None::<&str>,
                )
            })
            .collect::<tauri::Result<Vec<_>>>()?;
        for item in tray.recent.items()? {
            tray.recent.remove(&item)?;
        }
        for item in items {
            tray.recent.append(&item)?;
        }
        tray.recent.set_enabled(!recent_hosts.is_empty())?;
        content.recent_hosts = recent_hosts;
    }
    Ok(())
}

fn forwards_label(app: &AppHandle, labels: &TrayLabels) -> String {
    let count = app
        .state::<ForwardsState>()
        .forwarder
        .list()
        .into_iter()
        .filter(|event| event.status == ForwardStatus::Running)
        .count();
    labels.running_forwards.replace(COUNT, &count.to_string())
}

pub(crate) fn forwards_changed(app: &AppHandle) {
    if app.try_state::<Tray>().is_none() {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let tray = handle.state::<Tray>();
        let content = tray.content.lock().unwrap();
        if let Some(labels) = content.labels.as_ref() {
            let text = forwards_label(&handle, labels);
            if let Err(error) = tray.forwards.set_text(text) {
                log::debug!("Could not update the tray Port forward count: {error}");
            }
        }
    });
}

pub(crate) fn close_enabled(app: &AppHandle) -> bool {
    app.state::<SettingsState>()
        .with(|store| {
            Ok(store
                .sections()
                .get("workspacePreferences")
                .and_then(|prefs| prefs.get("closeToTray"))
                .and_then(Value::as_bool)
                .unwrap_or(false))
        })
        .unwrap_or(false)
}

pub(crate) async fn can_restore(app: &AppHandle) -> bool {
    let registered = app.try_state::<Tray>().is_some();
    #[cfg(target_os = "linux")]
    return registered && linux::panel_available().await;
    #[cfg(not(target_os = "linux"))]
    registered
}

pub(crate) async fn can_restore_at_login(app: &AppHandle) -> bool {
    #[cfg(target_os = "linux")]
    {
        use std::time::Duration;

        if app.try_state::<Tray>().is_none() {
            return false;
        }
        // A desktop session can start the application before its tray host.
        tokio::time::timeout(Duration::from_secs(2), async {
            while !linux::panel_available().await {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        })
        .await
        .is_ok()
    }
    #[cfg(not(target_os = "linux"))]
    can_restore(app).await
}

/// Call on the UI thread after checking that a tray action can bring it back.
pub(crate) fn hide(window: &WebviewWindow) -> tauri::Result<()> {
    window.hide()?;
    #[cfg(target_os = "linux")]
    watch_hidden(window);
    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) fn watch_hidden(window: &WebviewWindow) {
    linux::reveal_if_panel_disappears(window.clone());
}
