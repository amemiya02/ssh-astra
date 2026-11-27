//! Port forward commands: the rules saved on a Host (HostStore) and starting
//! and stopping them (PortForwarder). State changes are pushed to each Window’s
//! channel registered with `forwards_watch`.

use std::sync::Arc;

use super::watch::Watcher;
use sshastra_core::forward::{ForwardDraft, ForwardEvent, ForwardId, PortForward, PortForwarder};
use sshastra_core::hosts::HostId;
use tauri::ipc::Channel;
use tauri::{Manager, State, WebviewWindow};

use super::connections::{connect_host, schedule_os_detection};
use super::hosts::HostsState;
use crate::error::{CommandError, CommandResult};
use crate::prompts::{ChannelPrompter, PromptRequest};
use crate::windows;

/// The app's PortForwarder and the channel its state changes go to.
pub struct ForwardsState {
    pub forwarder: PortForwarder,
    watcher: Arc<Watcher<ForwardEvent>>,
}

impl Default for ForwardsState {
    fn default() -> Self {
        let watcher: Arc<Watcher<ForwardEvent>> = Arc::default();
        let sink = Arc::clone(&watcher);
        let forwarder = PortForwarder::with_listener(move |event| {
            sink.send(event);
        });
        Self { forwarder, watcher }
    }
}

impl ForwardsState {
    pub(crate) fn unwatch(&self, label: &str) {
        self.watcher.unsubscribe(label);
    }
}

/// Sends every later state change to `on_event` (replacing any earlier
/// channel for the same Window, e.g. after a reload) and returns the rules running or failed now.
#[tauri::command]
pub fn forwards_watch(
    window: WebviewWindow,
    forwards: State<'_, ForwardsState>,
    on_event: Channel<ForwardEvent>,
) -> Vec<ForwardEvent> {
    forwards
        .watcher
        .subscribe(window.label(), on_event, || forwards.forwarder.list())
}

/// Adds a rule to Host `host_id` (`id` omitted) or replaces its rule `id`.
/// A running rule keeps its old settings until restarted.
#[tauri::command]
pub fn forward_save(
    hosts: State<'_, HostsState>,
    host_id: HostId,
    id: Option<ForwardId>,
    draft: ForwardDraft,
) -> CommandResult<PortForward> {
    hosts.edit(|store| Ok(store.save_forward(&host_id, id, draft)?))
}

/// Stops and deletes Host `host_id`'s rule `id`.
#[tauri::command]
pub fn forward_delete(
    hosts: State<'_, HostsState>,
    forwards: State<'_, ForwardsState>,
    host_id: HostId,
    id: ForwardId,
) -> CommandResult<()> {
    hosts.edit(|store| Ok(store.delete_forward(&host_id, &id)?))?;
    forwards.forwarder.forget(&id);
    Ok(())
}

/// Starts Host `host_id`'s rule `id`, connecting first (through its Jump
/// hosts, also starting or restoring its rules) if needed; questions arrive on
/// `on_prompt` as for a Terminal.
#[tauri::command]
pub async fn forward_start(
    hosts: State<'_, HostsState>,
    window: WebviewWindow,
    forwards: State<'_, ForwardsState>,
    host_id: HostId,
    id: ForwardId,
    on_prompt: Channel<PromptRequest>,
) -> CommandResult<()> {
    let app = window.app_handle();
    let mut hops = hosts.with(|store| {
        let hops = store.jump_chain(&host_id)?;
        if !hops
            .last()
            .is_some_and(|host| host.forwards.iter().any(|f| f.id == id))
        {
            return Err(sshastra_core::hosts::HostStoreError::ForwardNotFound(id.clone()).into());
        }
        Ok(hops)
    })?;
    let host = hops.pop().expect("a jump chain ends with the Host itself");
    let prompter = Arc::new(ChannelPrompter::new(windows::prompts(&window)?, on_prompt));
    let connection = connect_host(app, &hops, &host, prompter).await?;
    schedule_os_detection(app, &host.id, &connection);
    let start = hosts.with(|store| {
        let rule = store
            .get(&host_id)
            .and_then(|host| host.forwards.iter().find(|f| f.id == id))
            .ok_or_else(|| sshastra_core::hosts::HostStoreError::ForwardNotFound(id.clone()))?;
        Ok(forwards.forwarder.start(connection, &host_id, rule))
    })?;
    start.await.map_err(CommandError::from)
}

/// Stops rule `id` (and clears its error, if it failed).
#[tauri::command]
pub fn forward_stop(forwards: State<'_, ForwardsState>, id: ForwardId) {
    forwards.forwarder.stop(&id);
}
