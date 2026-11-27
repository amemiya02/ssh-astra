//! Resource sampling is available only through a Window's open remote Terminal.

use std::time::Duration;

use sshastra_core::files::FsError;
use sshastra_core::monitor::{watch_resources, ResourceEvent, ResourceInterval};
use sshastra_core::terminal::{TerminalError, TerminalId, TerminalRegistry};
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};

use crate::error::CommandResult;
use crate::terminal_handoff::ResourceSubscription;
use crate::windows;

#[tauri::command]
pub fn terminal_resources_start(
    window: WebviewWindow,
    registry: State<'_, TerminalRegistry>,
    id: TerminalId,
    on_event: Channel<ResourceEvent>,
    interval_seconds: ResourceInterval,
) -> CommandResult<()> {
    let (
        connection,
        ResourceSubscription {
            mut stopped,
            channel,
            interval,
        },
    ) = windows::with_resources(&window, |resources| -> CommandResult<_> {
        let route = resources
            .terminals
            .get(&id)
            .ok_or(TerminalError::NotFound(id))?;
        let mut route = route.lock();
        let (_, connection) = registry.connection(id)?.ok_or(FsError::NotConnected)?;
        let stopped = route
            .start_resources(on_event.id(), interval_seconds)
            .ok_or(FsError::NotConnected)?;
        Ok((connection, stopped))
    })??;
    tauri::async_runtime::spawn(async move {
        // A reopened panel waits for the old channel to finish its cancellation.
        let lease = tokio::select! {
            biased;
            _ = &mut stopped => return,
            lease = tokio::time::timeout(Duration::from_secs(6), channel.lock()) => lease,
        };
        let Ok(_lease) = lease else {
            let _ = on_event.send(ResourceEvent::Unavailable);
            return;
        };
        watch_resources(&connection, stopped, interval, |event| {
            on_event.send(event).is_ok()
        })
        .await;
    });
    Ok(())
}

#[tauri::command]
pub fn terminal_resources_set_interval(
    window: WebviewWindow,
    id: TerminalId,
    subscription: u32,
    interval_seconds: ResourceInterval,
) -> CommandResult<()> {
    windows::with_resources(&window, |resources| {
        if let Some(route) = resources.terminals.get(&id) {
            route
                .lock()
                .set_resource_interval(subscription, interval_seconds);
        }
    })
}

#[tauri::command]
pub fn terminal_resources_stop(
    window: WebviewWindow,
    id: TerminalId,
    subscription: u32,
) -> CommandResult<()> {
    windows::with_resources(&window, |resources| {
        if let Some(route) = resources.terminals.get(&id) {
            route.lock().stop_resource_subscription(subscription);
        }
    })
}
