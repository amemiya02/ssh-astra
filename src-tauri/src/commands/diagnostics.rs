//! Native diagnostics actions and the allowlisted events sent by the webview.

use serde::Deserialize;
use tauri::{AppHandle, State};

use super::hosts::HostsState;
use crate::diagnostics::Logs;
use crate::error::CommandResult;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum OperationalEvent {
    FrontendError { line: u32, column: u32 },
    UnhandledRejection,
    UpdateCheck { result: UpdateCheckResult },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateCheckResult {
    Available,
    UpToDate,
    NoRelease,
    Failed,
}

#[tauri::command]
pub fn diagnostics_event(event: OperationalEvent) {
    match event {
        OperationalEvent::FrontendError { line, column } => {
            log::error!("frontend uncaught error line={line} column={column}");
        }
        OperationalEvent::UnhandledRejection => log::error!("frontend unhandled Promise rejection"),
        OperationalEvent::UpdateCheck { result } => match result {
            UpdateCheckResult::Available => log::info!("update check result=available"),
            UpdateCheckResult::UpToDate => log::info!("update check result=upToDate"),
            UpdateCheckResult::NoRelease => log::info!("update check result=noRelease"),
            UpdateCheckResult::Failed => log::warn!("update check result=failed"),
        },
    }
}

#[tauri::command]
pub async fn diagnostics_open_logs(logs: State<'_, Logs>) -> CommandResult<()> {
    logs.open_directory().map_err(Into::into)
}

#[tauri::command]
pub async fn diagnostics_report(
    app: AppHandle,
    logs: State<'_, Logs>,
    hosts: State<'_, HostsState>,
) -> CommandResult<String> {
    let hosts = hosts
        .with(|store| Ok(store.list().to_vec()))
        .unwrap_or_default();
    logs.report(&app, &hosts).map_err(Into::into)
}
