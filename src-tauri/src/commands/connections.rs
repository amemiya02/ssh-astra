//! Connecting to a Host: every connect (Terminal, Port forward, "connect
//! only") goes through [`connect_host`], which also starts the Host's
//! auto-start Port forwards. "Connect only" keeps a Connection open with no
//! Terminal (`HeldConnections`); holds are pushed to the single channel
//! registered with `connections_watch`.

use std::sync::Arc;

use super::watch::Watcher;
use sshastra_core::hosts::{Host, HostDraft, HostId};
use sshastra_core::ssh::{
    ConnectError, Connection, ConnectionManager, ConnectionSettings, HeldConnections, HeldEvent,
    Prompter,
};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use super::forwards::ForwardsState;
use super::hosts::HostsState;
use super::settings::SettingsState;
use crate::error::CommandResult;
use crate::prompts::{ChannelPrompter, PendingPrompts, PromptRequest};

/// Connects to `host` through its Jump hosts `hops` (outermost first), with
/// the global keepalive as the default, then starts the Host's auto-start Port
/// forwards (as saved now). Rules that fail to start are reported through
/// the forwards channel; they never fail the connect.
pub async fn connect_host(
    app: &AppHandle,
    hops: &[Host],
    host: &Host,
    prompter: Arc<dyn Prompter>,
) -> Result<Arc<Connection>, ConnectError> {
    let connections = configured_connections(app);
    let connection = connections.connect_through(hops, host, prompter).await?;
    let saved = app
        .state::<HostsState>()
        .with(|store| Ok(store.get(&host.id).cloned()))
        .ok()
        .flatten();
    if let Some(saved) = saved {
        app.state::<ForwardsState>()
            .forwarder
            .start_auto(Arc::clone(&connection), &saved)
            .await;
    }
    Ok(connection)
}

fn configured_connections(app: &AppHandle) -> State<'_, ConnectionManager> {
    let connections = app.state::<ConnectionManager>();
    // Applies to the Connections this opens; open ones keep theirs.
    let settings = app
        .state::<SettingsState>()
        .with(|store| Ok(store.section::<ConnectionSettings>(ConnectionSettings::SECTION)))
        .unwrap_or_default();
    connections.set_keepalive_interval(settings.keepalive_interval());
    connections
}

/// The app's held ("connect only") Connections and the channel their changes
/// go to.
pub struct ConnectionsState {
    held: HeldConnections,
    watcher: Arc<Watcher<HeldEvent>>,
}

impl Default for ConnectionsState {
    fn default() -> Self {
        let watcher: Arc<Watcher<HeldEvent>> = Arc::default();
        let sink = Arc::clone(&watcher);
        let held = HeldConnections::with_listener(move |event| {
            sink.send(event);
        });
        Self { held, watcher }
    }
}

impl ConnectionsState {
    /// Lets Host `host`'s held Connection go, if any (e.g. it was deleted).
    pub fn release(&self, host: &HostId) {
        self.held.release(host);
    }
}

/// Sends every later change to `on_event` (replacing any earlier channel)
/// and returns the Hosts held connected now.
#[tauri::command]
pub fn connections_watch(
    connections: State<'_, ConnectionsState>,
    on_event: Channel<HeldEvent>,
) -> Vec<HostId> {
    connections
        .watcher
        .subscribe(on_event, || connections.held.list())
}

/// "Connect only": connects to Host `host_id` (through its Jump hosts),
/// starts its auto-start Port forwards and keeps the Connection open with no
/// Terminal until `host_disconnect`. Questions arrive on `on_prompt`.
#[tauri::command]
pub async fn host_connect(
    app: AppHandle,
    hosts: State<'_, HostsState>,
    connections: State<'_, ConnectionsState>,
    pending: State<'_, Arc<PendingPrompts>>,
    host_id: HostId,
    on_prompt: Channel<PromptRequest>,
) -> CommandResult<()> {
    let mut hops = hosts.with(|store| Ok(store.jump_chain(&host_id)?))?;
    let host = hops.pop().expect("a jump chain ends with the Host itself");
    let prompter = Arc::new(ChannelPrompter {
        pending: Arc::clone(&pending),
        channel: on_prompt,
    });
    let connection = connect_host(&app, &hops, &host, prompter).await?;
    connections.held.hold(&host.id, connection);
    Ok(())
}

/// Tests the Host editor's draft over a private route, then disconnects.
#[tauri::command]
pub async fn host_test_connection(
    app: AppHandle,
    hosts: State<'_, HostsState>,
    pending: State<'_, Arc<PendingPrompts>>,
    id: Option<HostId>,
    draft: HostDraft,
    on_prompt: Channel<PromptRequest>,
) -> CommandResult<()> {
    let mut hops = hosts.with(|store| Ok(store.draft_jump_chain(id, draft)?))?;
    let host = hops.pop().expect("a jump chain ends with the draft Host");
    let prompter = Arc::new(ChannelPrompter {
        pending: Arc::clone(&pending),
        channel: on_prompt,
    });
    configured_connections(&app)
        .test_connection(&hops, &host, prompter)
        .await?;
    Ok(())
}

/// Ends "connect only" on Host `host_id`: stops its Port forwards and lets
/// the Connection go (it stays up while a Terminal uses it).
#[tauri::command]
pub fn host_disconnect(
    connections: State<'_, ConnectionsState>,
    forwards: State<'_, ForwardsState>,
    host_id: HostId,
) {
    forwards.forwarder.stop_host(&host_id);
    connections.release(&host_id);
}
