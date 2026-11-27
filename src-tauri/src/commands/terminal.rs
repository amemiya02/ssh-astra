//! Terminal commands. Output streams over a single `Channel` per Terminal so
//! ordering is preserved:
//! - output chunks are sent as raw bytes (an `ArrayBuffer` in JS, no JSON),
//! - a remote Terminal's Connection changes are JSON
//!   `{ "connection": { "state": "reconnecting", "attempt": 1, "attempts": 3 } }`
//!   (also `"connected"`, `"disconnected"` with a `reason`),
//! - a remote Terminal's shell reporting its directory (ShellIntegration) is
//!   JSON `{ "cwd": "/abs/path" }`,
//! - Shell integration markers and availability are JSON
//!   `{ "shellIntegration": { "type": "promptStart" } }` (or the matching event),
//! - the final message is JSON `{ "exitCode": number | null }`.
//!
//! Local terminals and remote Terminals share every command after `open`.

use std::sync::Arc;

use serde::Serialize;
use sshastra_core::hosts::HostId;
use sshastra_core::ssh::{RemoteTerminal, RemoteTerminalOptions};
use sshastra_core::terminal::{
    ConnectionState, LocalPty, ShellCommand, ShellIntegrationEvent, TerminalEvent, TerminalId,
    TerminalRegistry, TerminalSettings, TerminalSize, REPORT_CWD,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};

use super::connections::connect_host;
use super::hosts::HostsState;
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
    size: TerminalSize,
    on_event: Channel<InvokeResponseBody>,
) -> CommandResult<TerminalId> {
    let pty = LocalPty::spawn(
        ShellCommand::default_shell(),
        size,
        channel_sink(on_event, None),
    )?;
    Ok(registry.insert(Box::new(pty)))
}

/// Opens a Terminal on a saved Host, connecting first (through its Jump
/// hosts, if any) if needed. Progress and questions for the user arrive on
/// `on_prompt`. Answer questions with `prompt_answer`. If the Connection drops later, the Terminal
/// reconnects on its own, sending attempt states alongside progress and questions on `on_prompt`.
/// See `terminal_reconnect`.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects each managed state as an argument.
pub async fn remote_terminal_open(
    app: AppHandle,
    registry: State<'_, TerminalRegistry>,
    hosts: State<'_, HostsState>,
    settings: State<'_, SettingsState>,
    pending: State<'_, Arc<PendingPrompts>>,
    host_id: HostId,
    size: TerminalSize,
    on_event: Channel<InvokeResponseBody>,
    on_prompt: Channel<PromptRequest>,
) -> CommandResult<TerminalId> {
    // The Host last, after its Jump hosts (outermost first).
    let mut hops = hosts.with(|store| Ok(store.jump_chain(&host_id)?))?;
    let host = hops.pop().expect("a jump chain ends with the Host itself");
    let prompter = Arc::new(ChannelPrompter {
        pending: Arc::clone(&pending),
        channel: on_prompt.clone(),
    });
    let (target, prompts) = (host.clone(), prompter.clone());
    let connect = move || {
        let (app, hops, host, prompter) =
            (app.clone(), hops.clone(), target.clone(), prompts.clone());
        async move { connect_host(&app, &hops, &host, prompter).await }
    };
    let shell_integration = settings
        .with(|store| Ok(store.section::<TerminalSettings>(TerminalSettings::SECTION)))
        .unwrap_or_default()
        .shell_integration;
    let options = RemoteTerminalOptions::for_host(&host, shell_integration);
    let terminal = RemoteTerminal::open_with_progress(
        connect,
        options,
        size,
        channel_sink(on_event, Some(on_prompt)),
        host,
        prompter,
    )
    .await?;
    Ok(registry.insert(Box::new(terminal)))
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
