//! Settings commands: the versioned settings file (SettingsStore).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Map, Value};
use sshastra_core::agent::AgentSettings;
use sshastra_core::files::TransferSettings;
use sshastra_core::settings::SettingsStore;
use tauri::{ipc::Channel, State, WebviewWindow};

use super::transfers::TransfersState;
use super::watch::Watcher;

use crate::agent_transport::AgentService;
use crate::error::{CommandError, CommandResult};
use crate::windows::{is_window_section, save_window_setting, window_settings, SESSION};

/// The SettingsStore, or why it could not be loaded at startup (a damaged or
/// newer file, which is left untouched rather than overwritten).
pub struct SettingsState {
    store: Mutex<Result<SettingsStore, CommandError>>,
    changes: Watcher<SettingsChange>,
    revision: AtomicU64,
}

#[derive(Clone, Serialize)]
pub struct SettingsChange {
    section: String,
    value: Value,
    revision: u64,
}

impl SettingsState {
    pub fn new(store: Result<SettingsStore, CommandError>) -> Self {
        Self {
            store: Mutex::new(store),
            changes: Watcher::default(),
            revision: AtomicU64::new(0),
        }
    }

    pub fn with<T>(
        &self,
        f: impl FnOnce(&mut SettingsStore) -> CommandResult<T>,
    ) -> CommandResult<T> {
        let mut guard = self.store.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_mut() {
            Ok(store) => f(store),
            Err(e) => Err(e.clone()),
        }
    }

    pub(crate) fn unwatch(&self, label: &str) {
        self.changes.unsubscribe(label);
    }
}

fn snapshot(
    store: &SettingsStore,
    window: &WebviewWindow,
    agent: &AgentService,
) -> Map<String, Value> {
    let mut sections = window_settings(store, window.label());
    sections.insert(
        AgentSettings::SECTION.into(),
        json!({"enabled": agent.enabled()}),
    );
    sections
}

/// The shared settings and this Window's layout.
#[tauri::command]
pub fn settings_load(
    window: WebviewWindow,
    settings: State<'_, SettingsState>,
    agent: State<'_, AgentService>,
) -> CommandResult<Map<String, Value>> {
    settings.with(|store| Ok(snapshot(store, &window, &agent)))
}

/// Loads this Window's settings and streams all later changes.
#[tauri::command]
pub fn settings_watch(
    window: WebviewWindow,
    settings: State<'_, SettingsState>,
    agent: State<'_, AgentService>,
    on_change: Channel<SettingsChange>,
) -> CommandResult<Map<String, Value>> {
    settings.with(|store| {
        Ok(settings.changes.subscribe(window.label(), on_change, || {
            snapshot(store, &window, &agent)
        }))
    })
}

/// Replaces one section and saves the file. Sections the core runs on
/// (`transfers`) take effect at once.
#[tauri::command]
pub fn settings_set(
    window: WebviewWindow,
    settings: State<'_, SettingsState>,
    transfers: State<'_, TransfersState>,
    agent: State<'_, AgentService>,
    section: String,
    mut value: Value,
) -> CommandResult<SettingsChange> {
    settings.with(|store| {
        let window_local = is_window_section(&section);
        if window_local {
            save_window_setting(store, window.label(), &section, value.clone())?;
        } else if section == AgentSettings::SECTION {
            let enabled = value
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            value = json!({"enabled": enabled});
            agent.apply(enabled, || Ok(store.set(&section, value.clone())?))?;
        } else {
            if section == SESSION {
                return Err(sshastra_core::settings::SettingsError::ReservedSection.into());
            }
            store.set(&section, value.clone())?;
            if section == TransferSettings::SECTION {
                transfers.apply(&store.section(TransferSettings::SECTION));
            }
        }
        let change = SettingsChange {
            section,
            value,
            revision: settings.revision.fetch_add(1, Ordering::Relaxed) + 1,
        };
        if window_local {
            settings.changes.send_to(window.label(), change.clone());
        } else {
            settings.changes.send(change.clone());
        }
        Ok(change)
    })
}
