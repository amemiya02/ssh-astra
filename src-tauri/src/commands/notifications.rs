//! App-local desktop notifications, with native window activation on a click.

use tauri::WebviewWindow;
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
use tauri::{AppHandle, Manager};

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
use tauri_plugin_notification::NotificationExt;

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
pub fn listen(app: &AppHandle) -> tauri_plugin_notification::Result<()> {
    let app_handle = app.clone();
    app.notification().on_action(move |action| {
        if action.action_id() == "tap" {
            focus_main_window(&app_handle);
        }
    })
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window
            .show()
            .and_then(|()| window.unminimize())
            .and_then(|()| window.set_focus())
        {
            log::debug!("could not focus window after a notification click: {error}");
        }
    }
}

fn is_background(window: &WebviewWindow) -> bool {
    // When a native focus check fails, do not interrupt the user.
    matches!(window.is_focused(), Ok(false))
}

#[tauri::command]
pub async fn notification_show(window: WebviewWindow, title: String, body: String) {
    // Never put notifications on a desktop running the automated E2E smoke tests.
    if cfg!(feature = "e2e") || !is_background(&window) {
        return;
    }
    if let Err(error) = show(window, title, body) {
        log::debug!("could not show desktop notification: {error}");
    }
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn show(
    window: WebviewWindow,
    title: String,
    body: String,
) -> tauri_plugin_notification::Result<()> {
    // The freedesktop specification permits markup in the body. Keep Terminal
    // output and Host names as plain text when the notification server renders it.
    #[cfg(target_os = "linux")]
    let body = body
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    window
        .app_handle()
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show()
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn show(_: WebviewWindow, _: String, _: String) -> Result<(), &'static str> {
    Ok(())
}
