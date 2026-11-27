//! App-local desktop notifications, with native window activation on a click.

use serde::Deserialize;
use serde_json::Value;
use std::sync::LazyLock;
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
use tauri::AppHandle;
use tauri::{Manager, WebviewWindow};

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
use tauri_plugin_notification::NotificationExt;

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
pub fn listen(app: &AppHandle) -> tauri_plugin_notification::Result<()> {
    let app_handle = app.clone();
    app.notification().on_action(move |action| {
        if action.action_id() == "tap" {
            focus_active_window(&app_handle);
        }
    })
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn focus_active_window(app: &AppHandle) {
    if let Some(window) = crate::windows::active(app) {
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
        && !window
            .app_handle()
            .webview_windows()
            .values()
            .any(|window| window.is_focused().unwrap_or(false))
}

#[tauri::command]
pub async fn notification_request_attention(window: WebviewWindow) {
    if cfg!(feature = "e2e") || !matches!(window.is_focused(), Ok(false)) {
        return;
    }
    if let Err(error) = window.request_user_attention(Some(tauri::UserAttentionType::Informational))
    {
        log::debug!("could not request Window attention: {error}");
    }
}

#[tauri::command]
pub async fn notification_show(window: WebviewWindow, title: String, body: String) {
    show_in_background(window, title, body);
}

pub(super) fn show_in_background(window: WebviewWindow, title: String, body: String) {
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

/// The same locale identifiers and strings used by the Interface language setting.
#[derive(Clone, Copy, Default, Deserialize)]
pub(crate) enum NotificationLocale {
    #[default]
    #[serde(rename = "en")]
    English,
    #[serde(rename = "zh")]
    SimplifiedChinese,
    #[serde(rename = "zh-Hant")]
    TraditionalChinese,
}

impl NotificationLocale {
    pub(super) fn named(name: &str) -> Option<Self> {
        match name {
            "en" => Some(Self::English),
            "zh" => Some(Self::SimplifiedChinese),
            "zh-Hant" => Some(Self::TraditionalChinese),
            _ => None,
        }
    }

    pub(super) fn transfer_batch(
        self,
        completed: usize,
        failed: usize,
        cancelled: usize,
    ) -> (String, String) {
        static EN: LazyLock<Value> =
            LazyLock::new(|| locale(include_str!("../../../src/i18n/locales/en.json")));
        static ZH: LazyLock<Value> =
            LazyLock::new(|| locale(include_str!("../../../src/i18n/locales/zh.json")));
        static ZH_HANT: LazyLock<Value> =
            LazyLock::new(|| locale(include_str!("../../../src/i18n/locales/zh-Hant.json")));
        let localized = match self {
            Self::English => &*EN,
            Self::SimplifiedChinese => &*ZH,
            Self::TraditionalChinese => &*ZH_HANT,
        };
        let title = localized["title"]
            .as_str()
            .expect("transfer notification title");
        let body = localized["body"]
            .as_str()
            .expect("transfer notification body")
            .replace("{{completed}}", &completed.to_string())
            .replace("{{failed}}", &failed.to_string())
            .replace("{{cancelled}}", &cancelled.to_string());
        (title.to_owned(), body)
    }
}

fn locale(source: &str) -> Value {
    let mut messages: Value = serde_json::from_str(source).expect("bundled UI messages are JSON");
    messages["notifications"]["transfers"].take()
}
