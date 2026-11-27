//! Terminal commands. Output streams over a single `Channel` per Terminal so
//! ordering is preserved:
//! - output chunks are sent as raw bytes (an `ArrayBuffer` in JS, no JSON),
//! - a remote Terminal's Connection changes are JSON
//!   `{ "connection": { "state": "reconnecting", "attempt": 1, "attempts": 3 } }`
//!   (also `"connected"`, `"disconnected"` with a `reason`),
//! - the shell's directory is JSON `{ "cwd": "/abs/path" }`, read from the
//!   local process on macOS/Linux or reported by the remote shell,
//! - Shell integration markers and availability are JSON
//!   `{ "shellIntegration": { "type": "promptStart" } }` (or the matching event),
//! - Terminal log status is JSON `{ "terminalLog": { "state": "active" } }`,
//! - the final message is JSON `{ "exitCode": number | null }`.
//!
//! Local terminals and remote Terminals share every command after `open`.

use std::{path::PathBuf, sync::Arc};

use serde::Serialize;
use sshastra_core::hosts::HostId;
use sshastra_core::ssh::{RemoteTerminal, RemoteTerminalOptions};
use sshastra_core::terminal::{
    ConnectionState, LocalPty, ShellCommand, ShellIntegrationEvent, TerminalEvent, TerminalId,
    TerminalLog, TerminalLogStatus, TerminalRegistry, TerminalSettings, TerminalSize, REPORT_CWD,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};

use super::connections::HostRoute;
use super::settings::SettingsState;
use crate::error::CommandResult;
use crate::prompts::{ChannelPrompter, PendingPrompts, PromptAnswer, PromptRequest};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitMessage {
    exit_code: Option<u32>,
}

#[derive(Serialize)]
struct CwdMessage {
    cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellIntegrationMessage {
    shell_integration: ShellIntegrationEvent,
}

pub struct TerminalLogDirectory(pub PathBuf);

impl TerminalLogDirectory {
    fn resolve(&self, settings: &TerminalSettings) -> PathBuf {
        settings
            .log_directory
            .clone()
            .unwrap_or_else(|| self.0.clone())
    }
}

fn terminal_settings(settings: &SettingsState) -> TerminalSettings {
    settings
        .with(|store| Ok(store.section(TerminalSettings::SECTION)))
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalLogMessage {
    terminal_log: TerminalLogStatus,
}

fn terminal_log(
    host: &str,
    settings: &TerminalSettings,
    directory: &TerminalLogDirectory,
    on_event: &Channel<InvokeResponseBody>,
) -> Arc<TerminalLog> {
    let on_event = on_event.clone();
    Arc::new(TerminalLog::new(
        host,
        settings.auto_log.then(|| directory.resolve(settings)),
        move |terminal_log| send_json(&on_event, &TerminalLogMessage { terminal_log }),
    ))
}

#[derive(Serialize)]
struct ConnectionMessage {
    connection: ConnectionState,
}

fn send_json(channel: &Channel<InvokeResponseBody>, message: &impl Serialize) {
    if let Ok(json) = serde_json::to_string(message) {
        let _ = channel.send(InvokeResponseBody::Json(json));
    }
}

/// Forwards a Terminal's events to its channel in the wire format above.
fn channel_sink(
    on_event: Channel<InvokeResponseBody>,
    on_prompt: Option<Channel<PromptRequest>>,
) -> impl FnMut(TerminalEvent) + Send {
    move |event| {
        // A send only fails once the webview is gone; nothing left to tell.
        match event {
            TerminalEvent::Output(bytes) => {
                let _ = on_event.send(InvokeResponseBody::Raw(bytes));
            }
            TerminalEvent::Connection(connection) => {
                // Recovery states must reach the overlay in order with the progress
                // updates, while the Terminal stream still orders shell events.
                if let Some(channel) = &on_prompt {
                    let _ = channel.send(PromptRequest::Reconnect {
                        state: connection.clone(),
                    });
                }
                send_json(&on_event, &ConnectionMessage { connection });
            }
            TerminalEvent::Cwd(cwd) => send_json(&on_event, &CwdMessage { cwd }),
            TerminalEvent::ShellIntegration(shell_integration) => {
                send_json(&on_event, &ShellIntegrationMessage { shell_integration });
            }
            TerminalEvent::Exit { code } => send_json(&on_event, &ExitMessage { exit_code: code }),
        }
    }
}

/// Opens a Local terminal running the user's default shell.
#[tauri::command]
pub async fn local_terminal_open(
    registry: State<'_, TerminalRegistry>,
    settings: State<'_, SettingsState>,
    log_directory: State<'_, TerminalLogDirectory>,
    size: TerminalSize,
    on_event: Channel<InvokeResponseBody>,
    cwd: Option<PathBuf>,
) -> CommandResult<TerminalId> {
    let command = ShellCommand::default_shell();
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let command = match cwd {
        // portable-pty selects the user's home when this path is no longer a directory.
        Some(path) if path.is_absolute() => command.cwd(path),
        _ => command,
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let _ = cwd;
    let log = terminal_log(
        "Local",
        &terminal_settings(&settings),
        &log_directory,
        &on_event,
    );
    let pty = LocalPty::spawn(command, size, log.wrap(channel_sink(on_event, None)))?;
    Ok(registry.insert_logged(Box::new(pty), log))
}

/// Opens a Terminal on a Host, connecting first (through its Jump
/// hosts, if any) if needed. Progress and questions for the user arrive on
/// `on_prompt`. Answer questions with `prompt_answer`. If the Connection drops later, the Terminal
/// reconnects on its own, sending attempt states alongside progress and questions on `on_prompt`.
/// A split can supply the working directory for its initial shell.
/// See `terminal_reconnect`.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects each managed state as an argument.
pub async fn remote_terminal_open(
    app: AppHandle,
    registry: State<'_, TerminalRegistry>,
    settings: State<'_, SettingsState>,
    pending: State<'_, Arc<PendingPrompts>>,
    log_directory: State<'_, TerminalLogDirectory>,
    host_id: HostId,
    size: TerminalSize,
    on_event: Channel<InvokeResponseBody>,
    on_prompt: Channel<PromptRequest>,
    cwd: Option<String>,
) -> CommandResult<TerminalId> {
    let route = Arc::new(HostRoute::lookup(&app, &host_id)?);
    let host = route.host().clone();
    let prompter = Arc::new(ChannelPrompter {
        pending: Arc::clone(&pending),
        channel: on_prompt.clone(),
    });
    let prompts = prompter.clone();
    let connect = move || {
        let (app, route, prompter) = (app.clone(), Arc::clone(&route), prompts.clone());
        async move { route.connect(&app, prompter).await }
    };
    let settings = terminal_settings(&settings);
    let log = terminal_log(&host.name, &settings, &log_directory, &on_event);
    let mut options = RemoteTerminalOptions::for_host(&host, settings.shell_integration);
    options.initial_cwd = cwd;
    let terminal = RemoteTerminal::open_with_progress(
        connect,
        options,
        size,
        log.wrap(channel_sink(on_event, Some(on_prompt))),
        host,
        prompter,
    )
    .await?;
    Ok(registry.insert_logged(Box::new(terminal), log))
}

/// Tries a remote Terminal's dropped Connection again now (the overlay's
/// "Reconnect" button).
#[tauri::command]
pub async fn terminal_reconnect(
    registry: State<'_, TerminalRegistry>,
    id: TerminalId,
) -> CommandResult<()> {
    Ok(registry.reconnect(id)?)
}

/// Makes a Terminal's shell report its directory once, by typing a command
/// into it (the File panel's "sync" button, for shells without ShellIntegration).
#[tauri::command]
pub async fn terminal_report_cwd(
    registry: State<'_, TerminalRegistry>,
    id: TerminalId,
) -> CommandResult<()> {
    Ok(registry.write(id, REPORT_CWD.as_bytes())?)
}

/// Answers a question sent on a `remote_terminal_open` prompt channel.
#[tauri::command]
pub fn prompt_answer(pending: State<'_, Arc<PendingPrompts>>, id: u64, answer: PromptAnswer) {
    pending.answer(id, answer);
}

#[tauri::command]
pub async fn terminal_write(
    registry: State<'_, TerminalRegistry>,
    id: TerminalId,
    data: String,
) -> CommandResult<()> {
    Ok(registry.write(id, data.as_bytes())?)
}

#[tauri::command]
pub async fn terminal_resize(
    registry: State<'_, TerminalRegistry>,
    id: TerminalId,
    size: TerminalSize,
) -> CommandResult<()> {
    Ok(registry.resize(id, size)?)
}

#[tauri::command]
pub async fn terminal_close(
    registry: State<'_, TerminalRegistry>,
    id: TerminalId,
) -> CommandResult<()> {
    Ok(registry.close(id)?)
}

/// Starts writing Terminal output to a plain-text file.
#[tauri::command]
pub async fn terminal_log_start(
    registry: State<'_, TerminalRegistry>,
    settings: State<'_, SettingsState>,
    log_directory: State<'_, TerminalLogDirectory>,
    id: TerminalId,
) -> CommandResult<()> {
    registry.start_log(id, &log_directory.resolve(&terminal_settings(&settings)))?;
    Ok(())
}

/// Finishes writing this Terminal's log and closes the file.
#[tauri::command]
pub async fn terminal_log_stop(
    registry: State<'_, TerminalRegistry>,
    id: TerminalId,
) -> CommandResult<()> {
    Ok(registry.stop_log(id)?)
}
