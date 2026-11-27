//! Settings commands: the versioned settings file (SettingsStore).

use std::sync::Mutex;

use serde_json::{json, Map, Value};
use sshastra_core::agent::AgentSettings;
use sshastra_core::files::TransferSettings;
use sshastra_core::settings::SettingsStore;
use tauri::State;

use super::transfers::TransfersState;

use crate::agent_transport::AgentService;
use crate::error::{CommandError, CommandResult};

/// The SettingsStore, or why it could not be loaded at startup (a damaged or
/// newer file, which is left untouched rather than overwritten).
pub struct SettingsState(Mutex<Result<SettingsStore, CommandError>>);

impl SettingsState {
    pub fn new(store: Result<SettingsStore, CommandError>) -> Self {
        Self(Mutex::new(store))
    }

    pub fn with<T>(
        &self,
        f: impl FnOnce(&mut SettingsStore) -> CommandResult<T>,
    ) -> CommandResult<T> {
        let mut guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_mut() {
            Ok(store) => f(store),
            Err(e) => Err(e.clone()),
        }
    }
}

/// Every saved section by name.
#[tauri::command]
pub fn settings_load(
    settings: State<'_, SettingsState>,
    agent: State<'_, AgentService>,
) -> CommandResult<Map<String, Value>> {
    settings.with(|store| {
        let mut sections = store.sections().clone();
        sections.insert(AgentSettings::SECTION.into(), json!({"enabled": agent.enabled()}));
        Ok(sections)
    })
}

/// Replaces one section and saves the file. Sections the core runs on
/// (`transfers`) take effect at once.
#[tauri::command]
pub fn settings_set(
    settings: State<'_, SettingsState>,
    transfers: State<'_, TransfersState>,
    agent: State<'_, AgentService>,
    section: String,
    value: Value,
) -> CommandResult<()> {
    settings.with(|store| {
        if section == AgentSettings::SECTION {
            let enabled = value.get("enabled").and_then(Value::as_bool).unwrap_or(false);
            return agent.apply(enabled, || Ok(store.set(&section, json!({"enabled": enabled}))?));
        }
        store.set(&section, value)?;
        if section == TransferSettings::SECTION {
            transfers.apply(&store.section(TransferSettings::SECTION));
        }
        Ok(())
    })
}
