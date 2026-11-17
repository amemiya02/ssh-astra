//! Settings commands: the versioned settings file (SettingsStore).

use std::sync::Mutex;

use serde_json::{Map, Value};
use sshastra_core::settings::SettingsStore;
use tauri::State;

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
pub fn settings_load(settings: State<'_, SettingsState>) -> CommandResult<Map<String, Value>> {
    settings.with(|store| Ok(store.sections().clone()))
}

/// Replaces one section and saves the file.
#[tauri::command]
pub fn settings_set(
    settings: State<'_, SettingsState>,
    section: String,
    value: Value,
) -> CommandResult<()> {
    settings.with(|store| Ok(store.set(&section, value)?))
}
