//! Settings commands: the versioned settings file (SettingsStore).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Map, Value};
use sshastra_core::agent::AgentSettings;
use sshastra_core::files::TransferSettings;
use sshastra_core::settings::SettingsStore;
use sshastra_core::ssh::ConnectionSettings;
use tauri::{ipc::Channel, State, WebviewWindow};

use super::hosts::HostsState;
use super::ssh_config_export::{OpenSshSettings, OpenSshStatus};
use super::transfers::TransfersState;
use super::watch::Watcher;

use crate::agent_transport::AgentService;
use crate::error::{CommandError, CommandResult};
use crate::windows::{is_window_section, save_window_setting, window_settings, SESSION};

/// The SettingsStore, or why it could not be loaded at startup (a damaged or
/// newer file, which is left untouched rather than overwritten).
pub struct SettingsState {
    store: Mutex<Result<SettingsStore, CommandError>>,
    changes: Arc<SettingsChanges>,
}

#[derive(Default)]
pub struct SettingsChanges {
    watches: Watcher<SettingsChange>,
    revision: AtomicU64,
}

impl SettingsChanges {
    pub fn publish(&self, section: String, value: Value, window: Option<&str>) -> SettingsChange {
        let change = SettingsChange {
            section,
            value,
            revision: self.revision.fetch_add(1, Ordering::Relaxed) + 1,
        };
        if let Some(label) = window {
            self.watches.send_to(label, change.clone());
        } else {
            self.watches.send(change.clone());
        }
        change
    }
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
            changes: Arc::default(),
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

    pub fn changes(&self) -> Arc<SettingsChanges> {
        Arc::clone(&self.changes)
    }

    pub(crate) fn unwatch(&self, label: &str) {
        self.changes.watches.unsubscribe(label);
    }
}

fn snapshot(
    store: &SettingsStore,
    window: &WebviewWindow,
    agent: &AgentService,
    open_ssh: &OpenSshStatus,
) -> Map<String, Value> {
    let mut sections = window_settings(store, window.label());
    sections.insert(
        AgentSettings::SECTION.into(),
        json!({"enabled": agent.enabled()}),
    );
    sections.insert(OpenSshSettings::SECTION.into(), json!(open_ssh));
    sections
}

/// The shared settings and this Window's layout.
#[tauri::command]
pub fn settings_load(
    window: WebviewWindow,
    settings: State<'_, SettingsState>,
    agent: State<'_, AgentService>,
    hosts: State<'_, HostsState>,
) -> CommandResult<Map<String, Value>> {
    settings.with(|store| {
        hosts
            .open_ssh()
            .with_status(|status| Ok(snapshot(store, &window, &agent, status)))
    })
}

/// Loads this Window's settings and streams all later changes.
#[tauri::command]
pub fn settings_watch(
    window: WebviewWindow,
    settings: State<'_, SettingsState>,
    agent: State<'_, AgentService>,
    hosts: State<'_, HostsState>,
    on_change: Channel<SettingsChange>,
) -> CommandResult<Map<String, Value>> {
    settings.with(|store| {
        hosts.open_ssh().with_status(|status| {
            Ok(settings
                .changes
                .watches
                .subscribe(window.label(), on_change, || {
                    snapshot(store, &window, &agent, status)
                }))
        })
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
    hosts: State<'_, HostsState>,
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
            if section == SESSION || section == OpenSshSettings::SECTION {
                return Err(sshastra_core::settings::SettingsError::ReservedSection.into());
            }
            store.set(&section, value.clone())?;
            if section == TransferSettings::SECTION {
                transfers.apply(&store.section(TransferSettings::SECTION));
            }
            if section == ConnectionSettings::SECTION {
                let _ = hosts.with(|hosts_store| {
                    hosts.open_ssh().rebuild(
                        hosts_store.list(),
                        Some(store.section(ConnectionSettings::SECTION)),
                    );
                    Ok(())
                });
            }
        }
        Ok(settings
            .changes
            .publish(section, value, window_local.then(|| window.label())))
    })
}
