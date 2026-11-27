//! Command history IPC for saved Hosts. Only Shell integration can add entries.

use sshastra_core::hosts::{HostId, HostStoreError};
use sshastra_core::terminal::{CommandHistory, TerminalSettings};
use tauri::{AppHandle, Manager, State};

use super::hosts::HostsState;
use super::settings::SettingsState;
use crate::error::CommandResult;

pub(super) fn record(app: &AppHandle, host_id: &HostId, command: &str) {
    let _ = app.state::<HostsState>().with(|hosts| {
        // Quick connect keeps its ID when saved. Check the current saved Host
        // list, so that its existing Terminal can start recording at that point.
        app.state::<SettingsState>().with(|settings| {
            let settings: TerminalSettings = settings.section(TerminalSettings::SECTION);
            if let Err(error) = app
                .state::<CommandHistory>()
                .record(&settings, hosts, host_id, command)
            {
                log::warn!("Command history write failed: {:?}", error.kind());
            }
            Ok(())
        })
    });
}

#[tauri::command]
pub fn command_history_list(
    hosts: State<'_, HostsState>,
    history: State<'_, CommandHistory>,
    host_id: HostId,
) -> CommandResult<Vec<String>> {
    hosts.with(|store| {
        store
            .get(&host_id)
            .ok_or_else(|| HostStoreError::NotFound(host_id.clone()))?;
        Ok(history.list(&host_id)?)
    })
}

#[tauri::command]
pub fn command_history_clear(
    hosts: State<'_, HostsState>,
    history: State<'_, CommandHistory>,
    host_id: HostId,
) -> CommandResult<()> {
    hosts.with(|store| {
        store
            .get(&host_id)
            .ok_or_else(|| HostStoreError::NotFound(host_id.clone()))?;
        Ok(history.clear(&host_id)?)
    })
}
