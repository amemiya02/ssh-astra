//! Connecting to a Host: every connect (Terminal, Port forward, "connect
//! only") goes through [`connect_host`], which starts the Host's auto-start
//! and interrupted Port forwards. "Connect only" keeps a Connection open
//! with no Terminal (`HeldConnections`); holds are pushed to the channel
//! registered with `connections_watch`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use super::watch::Watcher;
use sshastra_core::agent::AgentPermission;
use sshastra_core::hosts::{Host, HostDraft, HostId};
use sshastra_core::ssh::{
    ConnectError, Connection, ConnectionManager, ConnectionSettings, HeldConnections, HeldEvent,
    Prompter, QuickConnectTarget, TemporaryHost,
};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use super::forwards::ForwardsState;
use super::hosts::HostsState;
use super::settings::SettingsState;
use crate::error::{CommandError, CommandResult};
use crate::prompts::{ChannelPrompter, PromptRequest};
use crate::windows;

/// Connects to `host` through its Jump hosts `hops` (outermost first), with
/// the global connection settings, then starts or restores the Host's saved
/// Port forwards. Rules that fail to start are reported through
/// the forwards channel; they never fail the connect.
pub async fn connect_host(
    app: &AppHandle,
    hops: &[Host],
    host: &Host,
    prompter: Arc<dyn Prompter>,
) -> Result<Arc<Connection>, ConnectError> {
    connect_saved(app, hops, host, prompter, None).await
}

async fn connect_saved(
    app: &AppHandle,
    hops: &[Host],
    host: &Host,
    prompter: Arc<dyn Prompter>,
    approved: Option<&QuickConnectTarget>,
) -> Result<Arc<Connection>, ConnectError> {
    if approved.is_some_and(|target| !target.matches_host(host)) {
        return Err(ConnectError::SshLinkTargetChanged);
    }

    let connections = configured_connections(app);
    let connection = connections.connect_through(hops, host, prompter).await?;
    // The manager may have waited for an older handshake in the same Host slot.
    // Validate the transport that actually won before starting forwards or opening a PTY.
    verify_connection(&connection, approved)?;
    let forwards = app.state::<ForwardsState>();
    let starts = app.state::<HostsState>().with(|store| {
        Ok(store
            .get(&host.id)
            .filter(|saved| approved.is_none_or(|target| target.matches_host(saved)))
            .map(|saved| {
                forwards
                    .forwarder
                    .start_auto(Arc::clone(&connection), saved)
            }))
    });
    if let Ok(Some(starts)) = starts {
        starts.await;
    }
    Ok(connection)
}

fn verify_connection(
    connection: &Connection,
    approved: Option<&QuickConnectTarget>,
) -> Result<(), ConnectError> {
    if approved.is_some_and(|target| !connection.matches_target(target)) {
        return Err(ConnectError::SshLinkTargetChanged);
    }
    Ok(())
}

fn os_detection_enabled(app: &AppHandle) -> bool {
    app.state::<SettingsState>()
        .with(|store| {
            Ok(store
                .section::<ConnectionSettings>(ConnectionSettings::SECTION)
                .detect_os)
        })
        .unwrap_or(false)
}

pub(super) fn schedule_os_detection(app: &AppHandle, id: &HostId, connection: &Arc<Connection>) {
    let (app, id, connection) = (app.clone(), id.clone(), Arc::clone(connection));
    tauri::async_runtime::spawn(async move {
        let enabled = os_detection_enabled(&app);
        let hosts = app.state::<HostsState>();
        let reserved = hosts
            .with(|store| Ok(store.begin_os_detection(&id, enabled)))
            .unwrap_or(false);
        if !reserved {
            return;
        }

        let detected_os = connection.detect_os().await;
        let _ = hosts.edit(|store| Ok(store.finish_os_detection(&id, detected_os)?));
    });
}

pub(super) fn detect_os_on_current_connection(app: AppHandle, id: HostId) {
    if os_detection_enabled(&app) {
        tauri::async_runtime::spawn(async move {
            if let Some(connection) = app.state::<ConnectionManager>().live(&id).await {
                schedule_os_detection(&app, &id, &connection);
            }
        });
    }
}

/// Clears the result and probes a live Connection if one is available.
#[tauri::command]
pub fn host_redetect_os(
    app: AppHandle,
    hosts: State<'_, HostsState>,
    id: HostId,
) -> CommandResult<()> {
    hosts.edit(|store| Ok(store.clear_os_detection(&id)?))?;
    detect_os_on_current_connection(app, id);
    Ok(())
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
    pub(crate) fn forget(&self, id: &HostId) {
        self.with(|entries| entries.remove(id));
    }
    fn with<T>(&self, f: impl FnOnce(&mut HashMap<HostId, Arc<TemporaryRoute>>) -> T) -> T {
        f(&mut self.0.lock().unwrap_or_else(|p| p.into_inner()))
    }
}

#[tauri::command]
pub fn temporary_host_create(
    window: WebviewWindow,
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
    windows::with_resources(&window, |resources| {
        temporary.with(|entries| entries.insert(host.id.clone(), Arc::new(route)));
        resources.temporary_hosts.insert(host.id.clone());
    })?;
    Ok(host)
}

/// Saves a Temporary Host while preserving its live Connection and run-only trust.
#[tauri::command]
pub fn temporary_host_save(
    window: WebviewWindow,
    hosts: State<'_, HostsState>,
    connections: State<'_, ConnectionManager>,
    temporary: State<'_, TemporaryHosts>,
    host_id: HostId,
    mut draft: HostDraft,
) -> CommandResult<Host> {
    draft.agent_access = AgentPermission::Off;
    let saved = temporary.with(|entries| {
        let route = entries
            .get(&host_id)
            .ok_or_else(CommandError::temporary_host_unavailable)?;
        let saved = hosts.edit(|store| {
            let hops = store.draft_jump_chain(Some(host_id.clone()), draft.clone())?;
            let saved = store.insert(host_id.clone(), draft)?;
            connections.preserve_temporary_host_trust(&route.host);
            route.saved.get_or_init(|| hops);
            Ok(saved)
        })?;
        entries.remove(&host_id);
        Ok::<_, CommandError>(saved)
    })?;
    let _ = windows::with_resources(&window, |resources| {
        resources.temporary_hosts.remove(&host_id)
    });
    detect_os_on_current_connection(window.app_handle().clone(), host_id);
    Ok(saved)
}

#[tauri::command]
pub fn temporary_host_forget(window: WebviewWindow, host_id: HostId) {
    windows::forget_temporary_host(&window, &host_id);
}

/// A Terminal or standalone File panel can open either a saved route or a Temporary Host.
pub(crate) enum HostRoute {
    /// The target is last, following any Jump hosts.
    Saved(Vec<Host>),
    Temporary(Arc<TemporaryRoute>),
}

impl HostRoute {
    pub async fn lookup(app: &AppHandle, id: &HostId) -> CommandResult<Self> {
        if let Some(entry) = app
            .state::<TemporaryHosts>()
            .with(|entries| entries.get(id).cloned())
        {
            return Ok(Self::Temporary(entry));
        }
        let hosts = app.state::<HostsState>();
        hosts.open_ssh().wait_for_startup().await;
        hosts.with(|store| Ok(Self::Saved(store.jump_chain(id)?)))
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
        approved: Option<&QuickConnectTarget>,
    ) -> Result<Arc<Connection>, ConnectError> {
        let hops = match self {
            Self::Saved(hops) => hops,
            Self::Temporary(entry) => match entry.saved.get() {
                Some(hops) => hops,
                None => {
                    if approved.is_some_and(|target| !target.matches_host(entry.host.host())) {
                        return Err(ConnectError::SshLinkTargetChanged);
                    }
                    let connection = configured_connections(app)
                        .connect_temporary(&entry.host, prompter)
                        .await?;
                    verify_connection(&connection, approved)?;
                    return Ok(connection);
                }
            },
        };
        let (host, jumps) = hops.split_last().expect("a saved route has a target");
        connect_saved(app, jumps, host, prompter, approved).await
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
    pub(crate) fn unwatch(&self, label: &str) {
        self.watcher.unsubscribe(label);
    }

    /// Lets Host `host`'s held Connection go, if any (e.g. it was deleted).
    pub fn release(&self, host: &HostId) {
        self.held.release(host);
    }
}

/// Sends every later change to `on_event` (replacing that Window’s earlier channel)
/// and returns the Hosts held connected now.
#[tauri::command]
pub fn connections_watch(
    window: WebviewWindow,
    connections: State<'_, ConnectionsState>,
    on_event: Channel<HeldEvent>,
) -> Vec<HostId> {
    connections
        .watcher
        .subscribe(window.label(), on_event, || connections.held.list())
}

/// "Connect only": connects to Host `host_id` (through its Jump hosts),
/// starts its auto-start Port forwards and keeps the Connection open with no
/// Terminal until `host_disconnect`. Questions arrive on `on_prompt`.
#[tauri::command]
pub async fn host_connect(
    window: WebviewWindow,
    hosts: State<'_, HostsState>,
    connections: State<'_, ConnectionsState>,
    host_id: HostId,
    on_prompt: Channel<PromptRequest>,
) -> CommandResult<()> {
    let app = window.app_handle();
    hosts.open_ssh().wait_for_startup().await;
    let mut hops = hosts.with(|store| Ok(store.jump_chain(&host_id)?))?;
    let host = hops.pop().expect("a jump chain ends with the Host itself");
    let prompter = Arc::new(ChannelPrompter::new(windows::prompts(&window)?, on_prompt));
    let connection = connect_host(app, &hops, &host, prompter).await?;
    schedule_os_detection(app, &host.id, &connection);
    connections.held.hold(&host.id, connection);
    Ok(())
}

/// Tests the Host editor's draft over a private route, then disconnects.
#[tauri::command]
pub async fn host_test_connection(
    window: WebviewWindow,
    hosts: State<'_, HostsState>,
    id: Option<HostId>,
    draft: HostDraft,
    on_prompt: Channel<PromptRequest>,
) -> CommandResult<()> {
    let app = window.app_handle();
    hosts.open_ssh().wait_for_startup().await;
    let mut hops = hosts.with(|store| Ok(store.draft_jump_chain(id, draft)?))?;
    let host = hops.pop().expect("a jump chain ends with the draft Host");
    let prompter = Arc::new(ChannelPrompter::new(windows::prompts(&window)?, on_prompt));
    configured_connections(app)
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
