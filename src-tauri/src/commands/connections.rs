//! Connecting to a Host: every connect (Terminal, Port forward, "connect
//! only") goes through [`connect_host`], which also starts the Host's
//! auto-start Port forwards. "Connect only" keeps a Connection open with no
//! Terminal (`HeldConnections`); holds are pushed to the single channel
//! registered with `connections_watch`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use super::watch::Watcher;
use sshastra_core::hosts::{Host, HostDraft, HostId};
use sshastra_core::ssh::{
    ConnectError, Connection, ConnectionManager, ConnectionSettings, HeldConnections, HeldEvent,
    Prompter, QuickConnectTarget, TemporaryHost,
};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use super::forwards::ForwardsState;
use super::hosts::HostsState;
use super::settings::SettingsState;
use crate::error::{CommandError, CommandResult};
use crate::prompts::{ChannelPrompter, PendingPrompts, PromptRequest};

/// Connects to `host` through its Jump hosts `hops` (outermost first), with
/// the global connection settings, then starts the Host's auto-start Port
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
    let _ = app.state::<SettingsState>().with(|store| {
        connections.apply_settings(&store.section(ConnectionSettings::SECTION));
        Ok(())
    });
    connections
}

#[derive(Default)]
pub struct TemporaryHosts(Mutex<HashMap<HostId, Arc<TemporaryRoute>>>);

pub(crate) struct TemporaryRoute {
    host: TemporaryHost,
    // An open Terminal retains this route. A later reconnect can then use
    // the saved settings even after the entry leaves the temporary registry.
    saved: OnceLock<Vec<Host>>,
}

impl TemporaryHosts {
    fn with<T>(&self, f: impl FnOnce(&mut HashMap<HostId, Arc<TemporaryRoute>>) -> T) -> T {
        f(&mut self.0.lock().unwrap_or_else(|p| p.into_inner()))
    }
}

#[tauri::command]
pub fn temporary_host_create(
    connections: State<'_, ConnectionManager>,
    temporary: State<'_, TemporaryHosts>,
    target: QuickConnectTarget,
) -> CommandResult<Host> {
    let local_user = if target.user.is_none() {
        whoami::username().map_err(std::io::Error::other)?
    } else {
        String::new()
    };
    let entry = connections.temporary_host(target, &local_user)?;
    let host = entry.host().clone();
    let route = TemporaryRoute {
        host: entry,
        saved: OnceLock::new(),
    };
    temporary.with(|entries| entries.insert(host.id.clone(), Arc::new(route)));
    Ok(host)
}

/// Saves a Temporary Host while preserving its live Connection and run-only trust.
#[tauri::command]
pub fn temporary_host_save(
    hosts: State<'_, HostsState>,
    connections: State<'_, ConnectionManager>,
    temporary: State<'_, TemporaryHosts>,
    host_id: HostId,
    draft: HostDraft,
) -> CommandResult<Host> {
    temporary.with(|entries| {
        let route = entries
            .get(&host_id)
            .ok_or_else(CommandError::temporary_host_unavailable)?;
        let saved = hosts.with(|store| {
            let hops = store.draft_jump_chain(Some(host_id.clone()), draft.clone())?;
            let saved = store.insert(host_id.clone(), draft)?;
            connections.preserve_temporary_host_trust(&route.host);
            route.saved.get_or_init(|| hops);
            Ok(saved)
        })?;
        entries.remove(&host_id);
        Ok(saved)
    })
}

#[tauri::command]
pub fn temporary_host_forget(temporary: State<'_, TemporaryHosts>, host_id: HostId) {
    temporary.with(|entries| entries.remove(&host_id));
}

/// A Terminal or standalone File panel can open either a saved route or a Temporary Host.
pub(crate) enum HostRoute {
    /// The target is last, following any Jump hosts.
    Saved(Vec<Host>),
    Temporary(Arc<TemporaryRoute>),
}

impl HostRoute {
    pub fn lookup(app: &AppHandle, id: &HostId) -> CommandResult<Self> {
        if let Some(entry) = app
            .state::<TemporaryHosts>()
            .with(|entries| entries.get(id).cloned())
        {
            return Ok(Self::Temporary(entry));
        }
        app.state::<HostsState>()
            .with(|store| Ok(Self::Saved(store.jump_chain(id)?)))
    }

    pub fn host(&self) -> &Host {
        match self {
            Self::Saved(hops) => hops.last().expect("a saved route has a target"),
            Self::Temporary(entry) => entry.host.host(),
        }
    }

    pub async fn connect(
        &self,
        app: &AppHandle,
        prompter: Arc<dyn Prompter>,
    ) -> Result<Arc<Connection>, ConnectError> {
        let hops = match self {
            Self::Saved(hops) => hops,
            Self::Temporary(entry) => match entry.saved.get() {
                Some(hops) => hops,
                None => {
                    return configured_connections(app)
                        .connect_temporary(&entry.host, prompter)
                        .await
                }
            },
        };
        let (host, jumps) = hops.split_last().expect("a saved route has a target");
        connect_host(app, jumps, host, prompter).await
    }
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
