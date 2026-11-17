//! Terminal commands. Output streams over a single `Channel` per Terminal so
//! ordering is preserved:
//! - output chunks are sent as raw bytes (an `ArrayBuffer` in JS, no JSON),
//! - the final message is JSON `{ "exitCode": number | null }`.
//!
//! Local terminals and remote Terminals share every command after `open`.

use std::sync::Arc;

use serde::Serialize;
use sshastra_core::hosts::HostId;
use sshastra_core::ssh::ConnectionManager;
use sshastra_core::terminal::{
    LocalPty, ShellCommand, TerminalEvent, TerminalId, TerminalRegistry, TerminalSize,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use super::hosts::HostsState;
use crate::error::CommandResult;
use crate::prompts::{ChannelPrompter, PendingPrompts, PromptAnswer, PromptRequest};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitMessage {
    exit_code: Option<u32>,
}

/// Forwards a Terminal's events to its channel in the wire format above.
fn channel_sink(on_event: Channel<InvokeResponseBody>) -> impl FnMut(TerminalEvent) + Send {
    move |event| {
        // A send only fails once the webview is gone; nothing left to tell.
        let _ = match event {
            TerminalEvent::Output(bytes) => on_event.send(InvokeResponseBody::Raw(bytes)),
            TerminalEvent::Exit { code } => {
                match serde_json::to_string(&ExitMessage { exit_code: code }) {
                    Ok(json) => on_event.send(InvokeResponseBody::Json(json)),
                    Err(_) => Ok(()),
                }
            }
        };
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
/// them with `prompt_answer`.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects each managed state as an argument.
pub async fn remote_terminal_open(
    registry: State<'_, TerminalRegistry>,
    hosts: State<'_, HostsState>,
    connections: State<'_, ConnectionManager>,
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
    let connection = connections.connect_through(&hops, &host, prompter).await?;
    let shell = connection.open_shell(size, channel_sink(on_event)).await?;
    Ok(registry.insert(Box::new(shell)))
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
