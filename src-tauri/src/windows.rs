//! Application Windows and their independent workspaces.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sshastra_core::files::{FsId, FsRegistry};
use sshastra_core::hosts::HostId;
use sshastra_core::settings::SettingsStore;
use sshastra_core::terminal::{TerminalId, TerminalRegistry};
use tauri::{App, AppHandle, Emitter, EventTarget, Manager, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

use crate::commands::connections::{ConnectionsState, TemporaryHosts};
use crate::commands::forwards::ForwardsState;
use crate::commands::hosts::HostsState;
use crate::commands::settings::SettingsState;
use crate::commands::transfers::TransfersState;
use crate::error::{CommandError, CommandResult};
use crate::prompts::PendingPrompts;
use crate::terminal_handoff::TerminalRoute;

pub(crate) mod tab_move;

pub(crate) const MAIN: &str = "main";
pub(crate) const SESSION: &str = "windowSession";
const LABEL_PREFIX: &str = "window-";

#[derive(Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct WindowSession {
    labels: Vec<String>,
    next_id: u64,
    layouts: BTreeMap<String, Map<String, Value>>,
}

impl Default for WindowSession {
    fn default() -> Self {
        Self {
            labels: vec![MAIN.into()],
            next_id: 1,
            layouts: BTreeMap::new(),
        }
    }
}

impl WindowSession {
    fn read(store: &SettingsStore) -> Self {
        let mut session: Self = store.section(SESSION);
        let mut seen = HashSet::new();
        session.labels.retain(|label| {
            if let Some(id) = window_id(label) {
                session.next_id = session.next_id.max(id + 1);
            } else if label != MAIN {
                return false;
            }
            seen.insert(label.clone())
        });
        if session.labels.is_empty() {
            session.labels.push(MAIN.into());
        }
        session.next_id = session.next_id.clamp(1, u64::MAX - 1);
        session.layouts.retain(|label, _| seen.contains(label));
        session
    }

    fn save(self, store: &mut SettingsStore) -> CommandResult<()> {
        Ok(store.set(
            SESSION,
            serde_json::to_value(self).expect("WindowSession is JSON"),
        )?)
    }

    fn workspace<'a>(&'a self, store: &'a SettingsStore, label: &str) -> Option<&'a Value> {
        if label == MAIN {
            store.sections().get("workspace")
        } else {
            self.layouts.get(label)?.get("workspace")
        }
    }
}

fn window_id(label: &str) -> Option<u64> {
    let suffix = label.strip_prefix(LABEL_PREFIX)?;
    let id: u64 = suffix.parse().ok()?;
    (id > 0 && id < u64::MAX && id.to_string() == suffix).then_some(id)
}

pub(crate) fn is_window_section(section: &str) -> bool {
    matches!(section, "layout" | "workspace")
}

pub(crate) fn window_settings(store: &SettingsStore, label: &str) -> Map<String, Value> {
    let mut sections = store.sections().clone();
    sections.remove(SESSION);
    if label != MAIN {
        sections.remove("layout");
        sections.remove("workspace");
        if let Some(layout) = WindowSession::read(store).layouts.remove(label) {
            sections.extend(layout.into_iter().filter(|(key, _)| is_window_section(key)));
        }
    }
    sections
}

pub(crate) fn save_window_setting(
    store: &mut SettingsStore,
    label: &str,
    section: &str,
    value: Value,
) -> CommandResult<()> {
    if label == MAIN {
        return Ok(store.set(section, value)?);
    }
    let mut session = WindowSession::read(store);
    if session.labels.iter().any(|open| open == label) {
        session
            .layouts
            .entry(label.into())
            .or_default()
            .insert(section.into(), value);
        session.save(store)?;
    }
    Ok(())
}

#[derive(Default)]
pub(crate) struct Windows {
    next_id: Mutex<u64>,
    closing: Mutex<HashSet<String>>,
    focused: Mutex<Option<String>>,
    startup: Mutex<Option<String>>,
    resources: Mutex<HashMap<String, WindowResources>>,
    moves: Mutex<HashMap<String, tab_move::TabMove>>,
    quitting: AtomicBool,
    pending_saves: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

/// Resources opened for a Window, closed if its webview disappears before sending its cleanup IPC.
#[derive(Default)]
pub(crate) struct WindowResources {
    pub(crate) terminals: HashMap<TerminalId, Arc<TerminalRoute>>,
    /// Remote entries refer to the same SFTP session as the File panel's registry entry.
    pub(crate) files: HashMap<FsId, Option<std::sync::Weak<sshastra_core::files::SftpFs>>>,
    pub(crate) temporary_hosts: HashSet<HostId>,
    prompts: Arc<PendingPrompts>,
}

pub(crate) fn with_resources<T>(
    window: &WebviewWindow,
    use_resources: impl FnOnce(&mut WindowResources) -> T,
) -> CommandResult<T> {
    window
        .state::<Windows>()
        .resources
        .lock()
        .unwrap()
        .get_mut(window.label())
        .map(use_resources)
        .ok_or_else(CommandError::window_closed)
}

pub(crate) fn terminal_route(app: &AppHandle, terminal: TerminalId) -> Option<Arc<TerminalRoute>> {
    app.state::<Windows>()
        .resources
        .lock()
        .unwrap()
        .values()
        .find_map(|resources| resources.terminals.get(&terminal).cloned())
}

pub(crate) fn forget_temporary_host(window: &WebviewWindow, id: &HostId) {
    let windows = window.state::<Windows>();
    let mut all = windows.resources.lock().unwrap();
    if let Some(resources) = all.get_mut(window.label()) {
        resources.temporary_hosts.remove(id);
    }
    if !all
        .values()
        .any(|window| window.temporary_hosts.contains(id))
    {
        window.state::<TemporaryHosts>().forget(id);
    }
}

pub(crate) fn prompts(window: &WebviewWindow) -> CommandResult<Arc<PendingPrompts>> {
    with_resources(window, |resources| Arc::clone(&resources.prompts))
}

pub(crate) fn restore(app: &App) -> tauri::Result<()> {
    let settings = app.state::<SettingsState>();
    let session = settings
        .with(|store| Ok(WindowSession::read(store)))
        .unwrap_or_default();
    let windows = app.state::<Windows>();
    *windows.next_id.lock().unwrap() = session.next_id;
    let mut opened = Vec::new();
    // Subsequent restored Windows open without taking focus from the first one.
    for label in &session.labels {
        match build(app.handle(), label, opened.is_empty()) {
            Ok(_) => opened.push(label.clone()),
            Err(error) => log::warn!("Could not restore window {label}: {error}"),
        }
    }
    if opened.is_empty() {
        build(app.handle(), MAIN, true)?;
        opened.push(MAIN.into());
    }
    *windows.focused.lock().unwrap() = opened.first().cloned();
    *windows.startup.lock().unwrap() = opened.first().cloned();
    Ok(())
}

fn build(app: &AppHandle, label: &str, focus: bool) -> tauri::Result<WebviewWindow> {
    let mut config = app.config().app.windows[0].clone();
    config.label = label.into();
    config.focus = focus;
    let builder = WebviewWindowBuilder::from_config(app, &config)?;
    let windows = app.state::<Windows>();
    windows
        .resources
        .lock()
        .unwrap()
        .insert(label.into(), WindowResources::default());
    let result = builder.build();
    if result.is_err() {
        windows.resources.lock().unwrap().remove(label);
    }
    result
}

fn reserve_label(windows: &Windows) -> Result<(String, u64), String> {
    if windows.quitting.load(Ordering::Acquire) {
        return Err("SSH Astra is quitting".into());
    }
    let mut next = windows.next_id.lock().unwrap();
    if *next == u64::MAX {
        return Err("No Window IDs remain".into());
    }
    let label = format!("{LABEL_PREFIX}{next}");
    *next += 1;
    Ok((label, *next))
}

fn remember(app: &AppHandle, label: &str, next_id: u64) {
    // Reserve the workspace before its webview can read or write settings.
    if let Err(error) = app.state::<SettingsState>().with(|store| {
        let mut session = WindowSession::read(store);
        session.labels.push(label.to_owned());
        session.next_id = session.next_id.max(next_id);
        session.save(store)
    }) {
        log::warn!("Could not save the open Windows: {error:?}");
    }
}

/// WebView2 can block window construction from a synchronous command.
#[tauri::command]
pub(crate) async fn window_new(app: AppHandle) -> Result<(), String> {
    let windows = app.state::<Windows>();
    let (label, next_id) = reserve_label(&windows)?;
    remember(&app, &label, next_id);
    match build(&app, &label, true) {
        Ok(window) => {
            *windows.focused.lock().unwrap() = Some(label);
            let _ = window.set_focus();
            Ok(())
        }
        Err(error) => {
            forget(&app, &label);
            Err(error.to_string())
        }
    }
}

fn forget(app: &AppHandle, label: &str) {
    if let Err(error) = app.state::<SettingsState>().with(|store| {
        let mut session = WindowSession::read(store);
        session.labels.retain(|open| open != label);
        session.layouts.remove(label);
        session.save(store)
    }) {
        log::warn!("Could not save the remaining Windows: {error:?}");
    }
}

/// Startup Hosts are chosen once per app, against the layouts of every restored Window.
#[tauri::command]
pub(crate) fn window_startup_workspaces(window: WebviewWindow) -> Option<Vec<Value>> {
    let app = window.app_handle();
    let windows = app.state::<Windows>();
    let mut startup = windows.startup.lock().unwrap();
    if startup.as_deref() != Some(window.label()) {
        return None;
    }
    *startup = None;
    Some(
        app.state::<SettingsState>()
            .with(|store| {
                let session = WindowSession::read(store);
                Ok(session
                    .labels
                    .iter()
                    .filter(|label| app.get_webview_window(label).is_some())
                    .filter_map(|label| session.workspace(store, label).cloned())
                    .collect())
            })
            .unwrap_or_default(),
    )
}

pub(crate) fn active(app: &AppHandle) -> Option<WebviewWindow> {
    let windows = app.webview_windows();
    if let Some(window) = windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
    {
        return Some(window.clone());
    }
    let runtime = app.try_state::<Windows>()?;
    let focused = runtime.focused.lock().unwrap();
    focused
        .as_ref()
        .and_then(|label| windows.get(label))
        .or_else(|| windows.get(MAIN))
        .or_else(|| windows.values().next())
        .cloned()
}

/// Closes a single Window or asks its caller to run the app quit flow if it is the last one.
#[tauri::command]
pub(crate) fn window_try_close(window: WebviewWindow) -> Result<bool, String> {
    let app = window.app_handle();
    let windows = app.state::<Windows>();
    let mut closing = windows.closing.lock().unwrap();
    if app
        .webview_windows()
        .keys()
        .all(|label| label == window.label() || closing.contains(label))
    {
        return Ok(true);
    }
    let newly_closing = closing.insert(window.label().into());
    drop(closing);
    if newly_closing {
        if let Err(error) = window.destroy() {
            windows.closing.lock().unwrap().remove(window.label());
            return Err(error.to_string());
        }
    }
    Ok(false)
}

/// The initiating Window has already drained its writes. Let the others drain
/// theirs before exiting, including when a layout changed just as Quit was chosen.
pub(crate) async fn finish_quit(window: WebviewWindow) {
    let app = window.app_handle();
    let windows = app.state::<Windows>();
    if windows.quitting.swap(true, Ordering::AcqRel) {
        return;
    }
    let mut receipts = Vec::new();
    for label in app
        .webview_windows()
        .into_keys()
        .filter(|label| label != window.label())
    {
        let (send, receive) = oneshot::channel();
        windows
            .pending_saves
            .lock()
            .unwrap()
            .insert(label.clone(), send);
        match app.emit_to(EventTarget::webview_window(&label), "app-exit-saving", ()) {
            Ok(()) => receipts.push(receive),
            Err(_) => {
                windows.pending_saves.lock().unwrap().remove(&label);
            }
        }
    }
    if tokio::time::timeout(Duration::from_secs(1), async move {
        for receipt in receipts {
            let _ = receipt.await;
        }
    })
    .await
    .is_err()
    {
        log::debug!("A Window did not respond before application exit");
    }
    app.exit(0);
}

#[tauri::command]
pub(crate) fn window_settings_saved(window: WebviewWindow) {
    if let Some(send) = window
        .state::<Windows>()
        .pending_saves
        .lock()
        .unwrap()
        .remove(window.label())
    {
        let _ = send.send(());
    }
}

pub(crate) fn focused(app: &AppHandle, label: &str) {
    *app.state::<Windows>().focused.lock().unwrap() = Some(label.into());
}

pub(crate) fn destroyed(app: &AppHandle, label: &str) {
    let windows = app.state::<Windows>();
    tab_move::window_destroyed(&windows, label);
    windows.pending_saves.lock().unwrap().remove(label);
    let closed_by_user = windows.closing.lock().unwrap().remove(label);
    if closed_by_user {
        forget(app, label);
    }
    app.state::<SettingsState>().unwatch(label);
    app.state::<HostsState>().unwatch(label);
    app.state::<ConnectionsState>().unwatch(label);
    app.state::<ForwardsState>().unwatch(label);
    app.state::<TransfersState>().unwatch(label);
    let resources = {
        let mut all = windows.resources.lock().unwrap();
        let resources = all.remove(label);
        if let Some(resources) = &resources {
            let temporary = app.state::<TemporaryHosts>();
            for id in &resources.temporary_hosts {
                if !all
                    .values()
                    .any(|window| window.temporary_hosts.contains(id))
                {
                    temporary.forget(id);
                }
            }
        }
        resources
    };
    if let Some(resources) = resources {
        resources.prompts.close();
        for route in resources.terminals.values() {
            let mut route = route.lock();
            route.stop_live_subscriptions();
            route.invalidate_reviews();
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let terminals = app.state::<TerminalRegistry>();
            for id in resources.terminals.into_keys() {
                let _ = terminals.close(id);
            }
            let files = app.state::<FsRegistry>();
            for id in resources.files.into_keys() {
                files.remove(id);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn restores_legacy_and_independent_window_layouts_from_the_same_settings_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"version":1,"workspace":{"activeId":"first"},"layout":{"sidebarView":"hosts"},"appearance":{"theme":"dark"}}"#,
        )
        .unwrap();
        let mut store = SettingsStore::open(&path).unwrap();
        let mut session = WindowSession::read(&store);
        assert_eq!(session.labels, [MAIN]);
        session.labels.push("window-1".into());
        session.save(&mut store).unwrap();
        save_window_setting(
            &mut store,
            "window-1",
            "workspace",
            json!({"activeId": "second"}),
        )
        .unwrap();
        save_window_setting(
            &mut store,
            MAIN,
            "layout",
            json!({"sidebarView": "snippets"}),
        )
        .unwrap();
        save_window_setting(
            &mut store,
            "window-1",
            "layout",
            json!({"sidebarView": "forwards"}),
        )
        .unwrap();

        let saved = SettingsStore::open(&path).unwrap();
        let main = window_settings(&saved, MAIN);
        let second = window_settings(&saved, "window-1");
        assert_eq!(main["workspace"]["activeId"], "first");
        assert_eq!(main["layout"]["sidebarView"], "snippets");
        assert_eq!(second["workspace"]["activeId"], "second");
        assert_eq!(second["layout"]["sidebarView"], "forwards");
        assert_eq!(main["appearance"], second["appearance"]);
        assert_eq!(WindowSession::read(&saved).next_id, 2);
    }

    #[test]
    fn repairs_window_labels_and_ignores_updates_from_a_closed_window() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = SettingsStore::open(directory.path().join("settings.json")).unwrap();
        store
            .set(
                SESSION,
                json!({
                    "labels": ["window-4", "window-4", "window-01", "other"],
                    "layouts": {"window-5": {"workspace": {"activeId": "closed"}}}
                }),
            )
            .unwrap();

        save_window_setting(
            &mut store,
            "window-5",
            "workspace",
            json!({"activeId": "too late"}),
        )
        .unwrap();
        let repaired = WindowSession::read(&store);
        assert_eq!(repaired.labels, ["window-4"]);
        assert_eq!(repaired.next_id, 5);
        assert!(repaired.layouts.is_empty());
    }
}
