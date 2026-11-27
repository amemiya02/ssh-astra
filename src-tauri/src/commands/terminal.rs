//! Terminal commands. Output streams over a single `Channel` per Terminal so
//! ordering is preserved:
//! - output chunks are sent as raw bytes (an `ArrayBuffer` in JS, no JSON),
//! - a remote Terminal's Connection changes are JSON
//!   `{ "connection": { "state": "reconnecting", "attempt": 1, "attempts": 3 } }`
//!   (also `"connected"`, `"disconnected"` with a `reason`),
//! - the shell's directory is JSON `{ "cwd": "/abs/path" }`, read from the
//!   local process on macOS/Linux or reported by the remote shell,
//! - a missing Local terminal shell is JSON `{ "localShellFallback": true }`,
//! - Shell integration markers and availability are JSON
//!   `{ "shellIntegration": { "type": "promptStart", "promptId": 1 } }` (or the matching event),
//! - Terminal log status is JSON `{ "terminalLog": { "state": "active" } }`,
//! - Recording status is JSON `{ "recording": { "state": "active" } }`,
//! - the final message is JSON `{ "exitCode": number | null }`.
//!
//! Local terminals and remote Terminals share every command after `open`.

use std::{path::PathBuf, sync::Arc};

use serde::Serialize;
use sshastra_core::hosts::HostId;
use sshastra_core::ssh::{QuickConnectTarget, RemoteTerminal, RemoteTerminalOptions};
use sshastra_core::terminal::{
    local_shell_command, local_shells, local_wsl_paths, ConnectionState, LocalPty, LocalShell,
    OutputKind, OutputStatus, SavedTerminalMetadata, ShellCommand, ShellIntegrationEvent,
    TerminalEvent, TerminalId, TerminalOutput, TerminalRegistry, TerminalSettings, TerminalSize,
    REPORT_CWD,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State, Webview, WebviewWindow};

use super::agent::PendingScreens;
use super::command_history;
use super::connections::{detect_os_on_current_connection, HostRoute};
use super::settings::SettingsState;
use crate::error::{CommandError, CommandResult};
use crate::prompts::{ChannelPrompter, PromptAnswer, PromptRequest};
use crate::windows;

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
struct LocalShellFallbackMessage {
    local_shell_fallback: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellIntegrationMessage {
    shell_integration: ShellIntegrationEvent,
}

pub struct TerminalOutputDirectory(pub PathBuf);

impl TerminalOutputDirectory {
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
enum OutputMessage {
    TerminalLog(OutputStatus),
    Recording(OutputStatus),
}

fn terminal_output(
    host: &str,
    size: TerminalSize,
    settings: &TerminalSettings,
    directory: &TerminalOutputDirectory,
    on_event: &Channel<InvokeResponseBody>,
) -> Arc<TerminalOutput> {
    let on_event = on_event.clone();
    Arc::new(TerminalOutput::new(
        host,
        size,
        settings.auto_log.then(|| directory.resolve(settings)),
        move |kind, status| {
            let message = match kind {
                OutputKind::Log => OutputMessage::TerminalLog(status),
                OutputKind::Recording => OutputMessage::Recording(status),
            };
            send_json(&on_event, &message);
        },
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

#[tauri::command]
pub async fn local_terminal_shells() -> Vec<LocalShell> {
    local_shells().await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedLocalTerminal {
    id: TerminalId,
    shell_program: String,
    wsl_distribution: Option<String>,
}

/// Opens a Local terminal with the selected shell or the user's system default.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects each managed state as an argument.
pub async fn local_terminal_open(
    window: WebviewWindow,
    registry: State<'_, TerminalRegistry>,
    settings: State<'_, SettingsState>,
    output_directory: State<'_, TerminalOutputDirectory>,
    size: TerminalSize,
    on_event: Channel<InvokeResponseBody>,
    cwd: Option<PathBuf>,
    shell_id: Option<String>,
) -> CommandResult<OpenedLocalTerminal> {
    let (command, wsl_distribution) = match shell_id.as_deref() {
        Some(id) => match local_shell_command(id).await {
            Some(command) => (command, id.strip_prefix("wsl:").map(str::to_owned)),
            None => {
                send_json(
                    &on_event,
                    &LocalShellFallbackMessage {
                        local_shell_fallback: true,
                    },
                );
                (ShellCommand::default_shell(), None)
            }
        },
        None => (ShellCommand::default_shell(), None),
    };
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let command = match cwd {
        // portable-pty selects the user's home when this path is no longer a directory.
        Some(path) if path.is_absolute() => command.cwd(path),
        _ => command,
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let _ = cwd;
    let output = terminal_output(
        "Local",
        size,
        &terminal_settings(&settings),
        &output_directory,
        &on_event,
    );
    let pty = LocalPty::spawn(command, size, output.wrap(channel_sink(on_event, None)))?;
    let shell_program = pty.shell_program().to_owned();
    let id = registry.insert_with_output(Box::new(pty), output);
    track_terminal(&window, &registry, id)?;
    Ok(OpenedLocalTerminal {
        id,
        shell_program,
        wsl_distribution,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalWslPaths {
    shell_program: String,
    paths: Vec<String>,
}

/// Translates dropped file paths using the running WSL distribution's mounts and login shell.
#[tauri::command]
pub async fn local_terminal_wsl_paths(
    distribution: String,
    paths: Vec<String>,
) -> Option<LocalWslPaths> {
    let (shell_program, paths) = local_wsl_paths(&distribution, &paths).await?;
    Some(LocalWslPaths {
        shell_program,
        paths,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedRemoteTerminal {
    id: TerminalId,
    saved_host: bool,
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
    window: WebviewWindow,
    webview: Webview,
    registry: State<'_, TerminalRegistry>,
    settings: State<'_, SettingsState>,
    pending_screens: State<'_, Arc<PendingScreens>>,
    output_directory: State<'_, TerminalOutputDirectory>,
    host_id: HostId,
    size: TerminalSize,
    on_event: Channel<InvokeResponseBody>,
    on_prompt: Channel<PromptRequest>,
    cwd: Option<String>,
    expected_target: Option<QuickConnectTarget>,
) -> CommandResult<OpenedRemoteTerminal> {
    let app = window.app_handle().clone();
    let route = Arc::new(HostRoute::lookup(&app, &host_id)?);
    let host = route.host();
    // A saved Host may be edited in another window while link approval is pending.
    if expected_target.is_some_and(|target| {
        target.address != host.address
            || target.port != host.port
            || target.user.as_deref() != Some(host.user.as_str())
    }) {
        return Err(CommandError::ssh_link_target_changed());
    }
    let saved_host = matches!(route.as_ref(), HostRoute::Saved(_));
    let metadata = saved_host.then(|| {
        let screen = pending_screens.reader(webview.label().to_owned(), on_event.clone());
        Arc::new(SavedTerminalMetadata::new(host_id.clone()).with_screen_reader(screen))
    });
    let observed = metadata.clone();
    let host = host.clone();
    let prompter = Arc::new(ChannelPrompter {
        pending: windows::prompts(&window)?,
        channel: on_prompt.clone(),
    });
    let prompts = prompter.clone();
    let connect_app = app.clone();
    let connect = move || {
        let (app, route, prompter) = (connect_app.clone(), Arc::clone(&route), prompts.clone());
        async move { route.connect(&app, prompter).await }
    };
    let settings = terminal_settings(&settings);
    let output = terminal_output(&host.name, size, &settings, &output_directory, &on_event);
    let mut options = RemoteTerminalOptions::for_host(&host, settings.shell_integration);
    options.initial_cwd = cwd;
    let (reconnect_app, reconnect_host_id) = (app.clone(), host_id.clone());
    let mut sink = channel_sink(on_event, Some(on_prompt));
    let terminal = RemoteTerminal::open_with_progress(
        connect,
        options,
        size,
        output.wrap(move |event| {
            if let Some(metadata) = &observed {
                metadata.observe(&event);
            }
            if let TerminalEvent::ShellIntegration(ShellIntegrationEvent::CommandStart {
                command_line: Some(command),
            }) = &event
            {
                command_history::record(&reconnect_app, &reconnect_host_id, command);
            }
            let reconnected =
                matches!(event, TerminalEvent::Connection(ConnectionState::Connected));
            sink(event);
            if reconnected {
                detect_os_on_current_connection(reconnect_app.clone(), reconnect_host_id.clone());
            }
        }),
        host,
        prompter,
    )
    .await?;
    // Open the PTY before using another session channel on the same SSH transport.
    detect_os_on_current_connection(app, host_id);
    let id = registry.insert_with_metadata(Box::new(terminal), output, metadata);
    track_terminal(&window, &registry, id)?;
    Ok(OpenedRemoteTerminal { id, saved_host })
}

#[tauri::command]
pub fn terminal_set_title(registry: State<'_, TerminalRegistry>, id: TerminalId, title: String) {
    registry.set_title(id, title);
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

/// Follows a File panel only if the remote shell is still at the observed prompt.
#[tauri::command]
pub async fn terminal_follow_file_directory(
    registry: State<'_, TerminalRegistry>,
    id: TerminalId,
    prompt_id: u64,
    path: String,
) -> CommandResult<()> {
    Ok(registry.follow_file_directory(id, prompt_id, &path)?)
}

/// Answers a question sent on a `remote_terminal_open` prompt channel.
#[tauri::command]
pub fn prompt_answer(window: WebviewWindow, id: u64, answer: PromptAnswer) {
    if let Ok(pending) = windows::prompts(&window) {
        pending.answer(id, answer);
    }
}

#[tauri::command]
pub async fn terminal_write(
    registry: State<'_, TerminalRegistry>,
    id: TerminalId,
    data: String,
    generation: Option<u64>,
) -> CommandResult<()> {
    match generation {
        Some(generation) => registry.write_for_connection(id, generation, data.as_bytes())?,
        None => registry.write(id, data.as_bytes())?,
    }
    Ok(())
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
    window: WebviewWindow,
    registry: State<'_, TerminalRegistry>,
    id: TerminalId,
) -> CommandResult<()> {
    let _ = windows::with_resources(&window, |resources| resources.terminals.remove(&id));
    Ok(registry.close(id)?)
}

fn track_terminal(
    window: &WebviewWindow,
    registry: &TerminalRegistry,
    id: TerminalId,
) -> CommandResult<()> {
    if let Err(error) = windows::with_resources(window, |resources| resources.terminals.insert(id))
    {
        let _ = registry.close(id);
        return Err(error);
    }
    Ok(())
}

/// Starts writing Terminal output to a plain-text file.
#[tauri::command]
pub async fn terminal_log_start(
    registry: State<'_, TerminalRegistry>,
    settings: State<'_, SettingsState>,
    output_directory: State<'_, TerminalOutputDirectory>,
    id: TerminalId,
) -> CommandResult<()> {
    registry.start_log(id, &output_directory.resolve(&terminal_settings(&settings)))?;
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

/// Starts recording Terminal output and size changes to an asciicast v2 file.
#[tauri::command]
pub async fn terminal_recording_start(
    registry: State<'_, TerminalRegistry>,
    settings: State<'_, SettingsState>,
    output_directory: State<'_, TerminalOutputDirectory>,
    id: TerminalId,
) -> CommandResult<()> {
    registry.start_recording(id, &output_directory.resolve(&terminal_settings(&settings)))?;
    Ok(())
}

/// Finishes writing this Terminal's Recording and closes the file.
#[tauri::command]
pub async fn terminal_recording_stop(
    registry: State<'_, TerminalRegistry>,
    id: TerminalId,
) -> CommandResult<()> {
    Ok(registry.stop_recording(id)?)
}
