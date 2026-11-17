//! Terminal commands. Output streams over a single `Channel` per Terminal so
//! ordering is preserved:
//! - output chunks are sent as raw bytes (an `ArrayBuffer` in JS, no JSON),
//! - a remote Terminal's Connection changes are JSON
//!   `{ "connection": { "state": "reconnecting", "attempt": 1, "attempts": 3 } }`
//!   (also `"connected"`, `"disconnected"` with a `reason`),
//! - a remote Terminal's shell reporting its directory (ShellIntegration) is
//!   JSON `{ "cwd": "/abs/path" }`,
//! - the final message is JSON `{ "exitCode": number | null }`.
//!
//! Local terminals and remote Terminals share every command after `open`.

use std::sync::Arc;

use serde::Serialize;
use sshastra_core::hosts::HostId;
use sshastra_core::ssh::{
    ConnectionManager, ConnectionSettings, ReconnectPolicy, RemoteTerminal, RemoteTerminalOptions,
};
use sshastra_core::terminal::{
    ConnectionState, LocalPty, ShellCommand, TerminalEvent, TerminalId, TerminalRegistry,
    TerminalSettings, TerminalSize, REPORT_CWD,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

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
struct ConnectionMessage {
    connection: ConnectionState,
}

fn send_json(channel: &Channel<InvokeResponseBody>, message: &impl Serialize) {
    if let Ok(json) = serde_json::to_string(message) {
        let _ = channel.send(InvokeResponseBody::Json(json));
    }
}

/// Forwards a Terminal's events to its channel in the wire format above.
fn channel_sink(on_event: Channel<InvokeResponseBody>) -> impl FnMut(TerminalEvent) + Send {
    move |event| {
        // A send only fails once the webview is gone; nothing left to tell.
        match event {
            TerminalEvent::Output(bytes) => {
                let _ = on_event.send(InvokeResponseBody::Raw(bytes));
            }
            TerminalEvent::Connection(connection) => {
                send_json(&on_event, &ConnectionMessage { connection })
            }
            TerminalEvent::Cwd(cwd) => send_json(&on_event, &CwdMessage { cwd }),
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
    let pty = LocalPty::spawn(ShellCommand::default_shell(), size, channel_sink(on_event))?;
    Ok(registry.insert(Box::new(pty)))
}

/// Opens a Terminal on a saved Host, connecting first (through its Jump
/// hosts, if any) if needed. Questions
/// for the user (trust this host key? password?) arrive on `on_prompt`; answer
/// them with `prompt_answer`. If the Connection drops later, the Terminal
/// reconnects on its own (asking on `on_prompt` again if needed); see
/// `terminal_reconnect`.
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
        channel: on_prompt,
    });
    let connect = move || {
        let (app, hops, host, prompter) =
            (app.clone(), hops.clone(), host.clone(), prompter.clone());
        async move {
            let connections = app.state::<ConnectionManager>();
            // Applies to the Connections this opens; open ones keep theirs.
            let settings = app
                .state::<SettingsState>()
                .with(|store| Ok(store.section::<ConnectionSettings>(ConnectionSettings::SECTION)))
                .unwrap_or_default();
            connections.set_keepalive_interval(settings.keepalive_interval());
            connections.connect_through(&hops, &host, prompter).await
        }
    };
    let shell_integration = settings
        .with(|store| Ok(store.section::<TerminalSettings>(TerminalSettings::SECTION)))
        .unwrap_or_default()
        .shell_integration;
    let options = RemoteTerminalOptions {
        reconnect: ReconnectPolicy::default(),
        shell_integration,
    };
    let terminal =
        RemoteTerminal::open_with(connect, options, size, channel_sink(on_event)).await?;
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
