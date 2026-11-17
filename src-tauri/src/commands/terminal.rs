//! Terminal commands. Output streams over a single `Channel` per Terminal so
//! ordering is preserved:
//! - output chunks are sent as raw bytes (an `ArrayBuffer` in JS, no JSON),
//! - the final message is JSON `{ "exitCode": number | null }`.

use serde::Serialize;
use sshastra_core::terminal::{
    LocalPty, ShellCommand, TerminalEvent, TerminalId, TerminalRegistry, TerminalSize,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::error::CommandResult;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitMessage {
    exit_code: Option<u32>,
}

/// Opens a Local terminal running the user's default shell.
#[tauri::command]
pub async fn local_terminal_open(
    registry: State<'_, TerminalRegistry>,
    size: TerminalSize,
    on_event: Channel<InvokeResponseBody>,
) -> CommandResult<TerminalId> {
    let pty = LocalPty::spawn(ShellCommand::default_shell(), size, move |event| {
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
    })?;
    Ok(registry.insert(Box::new(pty)))
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
