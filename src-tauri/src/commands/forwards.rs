//! Port forward commands: the rules saved on a Host (HostStore) and starting
//! and stopping them (PortForwarder). State changes are pushed to the single
//! channel registered with `forwards_watch`.

use std::sync::{Arc, Mutex};

use sshastra_core::forward::{ForwardDraft, ForwardEvent, ForwardId, PortForward, PortForwarder};
use sshastra_core::hosts::HostId;
use sshastra_core::ssh::{ConnectionManager, ConnectionSettings};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use super::hosts::HostsState;
use super::settings::SettingsState;
use crate::error::{CommandError, CommandResult};
use crate::prompts::{ChannelPrompter, PendingPrompts, PromptRequest};

/// The app's PortForwarder and the channel its state changes go to.
pub struct ForwardsState {
    pub forwarder: PortForwarder,
    watcher: Arc<Mutex<Option<Channel<ForwardEvent>>>>,
}

impl Default for ForwardsState {
    fn default() -> Self {
        let watcher: Arc<Mutex<Option<Channel<ForwardEvent>>>> = Arc::default();
        let sink = Arc::clone(&watcher);
        let forwarder = PortForwarder::with_listener(move |event| {
            if let Some(channel) = sink.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
                // Fails only once the webview is gone.
                let _ = channel.send(event);
            }
        });
        Self { forwarder, watcher }
    }
}

/// Sends every later state change to `on_event` (replacing any earlier
/// channel, e.g. after a reload) and returns the rules running or failed now.
#[tauri::command]
pub fn forwards_watch(
    forwards: State<'_, ForwardsState>,
    on_event: Channel<ForwardEvent>,
) -> Vec<ForwardEvent> {
    *forwards.watcher.lock().unwrap_or_else(|p| p.into_inner()) = Some(on_event);
    forwards.forwarder.list()
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
    hosts.with(|store| Ok(store.save_forward(&host_id, id, draft)?))
}

/// Stops and deletes Host `host_id`'s rule `id`.
#[tauri::command]
pub fn forward_delete(
    hosts: State<'_, HostsState>,
    forwards: State<'_, ForwardsState>,
    host_id: HostId,
    id: ForwardId,
) -> CommandResult<()> {
    hosts.with(|store| Ok(store.delete_forward(&host_id, &id)?))?;
    forwards.forwarder.stop(&id);
    Ok(())
}

/// Starts Host `host_id`'s rule `id`, connecting first (through its Jump
/// hosts) if needed; questions arrive on `on_prompt` as for a Terminal.
#[tauri::command]
pub async fn forward_start(
    hosts: State<'_, HostsState>,
    app: AppHandle,
    forwards: State<'_, ForwardsState>,
    pending: State<'_, Arc<PendingPrompts>>,
    host_id: HostId,
    id: ForwardId,
    on_prompt: Channel<PromptRequest>,
) -> CommandResult<()> {
    let (mut hops, rule) = hosts.with(|store| {
        let hops = store.jump_chain(&host_id)?;
        let rule = hops
            .last()
            .and_then(|host| host.forwards.iter().find(|f| f.id == id))
            .cloned()
            .ok_or_else(|| sshastra_core::hosts::HostStoreError::ForwardNotFound(id.clone()))?;
        Ok((hops, rule))
    })?;
    let host = hops.pop().expect("a jump chain ends with the Host itself");
    let prompter = Arc::new(ChannelPrompter {
        pending: Arc::clone(&pending),
        channel: on_prompt,
    });
    // Applies to the Connections this opens; open ones keep theirs.
    let keepalive = app
        .state::<SettingsState>()
        .with(|store| Ok(store.section::<ConnectionSettings>(ConnectionSettings::SECTION)))
        .unwrap_or_default()
        .keepalive_interval();
    let connections = app.state::<ConnectionManager>();
    connections.set_keepalive_interval(keepalive);
    let connection = connections.connect_through(&hops, &host, prompter).await?;
    forwards
        .forwarder
        .start(connection, &host.id, &rule)
        .map_err(CommandError::from)
}

/// Stops rule `id` (and clears its error, if it failed).
#[tauri::command]
pub fn forward_stop(forwards: State<'_, ForwardsState>, id: ForwardId) {
    forwards.forwarder.stop(&id);
}
