//! Runs Port forward rules. A running rule holds its Host's Connection, so the
//! Connection stays up while any rule on it runs, even with no Terminal open;
//! stopping the last one lets it disconnect.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::io;
use std::net::{SocketAddr, TcpListener as StdListener};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::Serialize;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::{JoinHandle, JoinSet};

use super::{socks, ForwardId, ForwardKind, PortForward};
use crate::hosts::{Host, HostId};
use crate::ssh::{Connection, RemoteListener};

/// How often a running rule checks that its Connection is still up.
const CONNECTION_CHECK: Duration = Duration::from_secs(1);

/// A rule's state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ForwardStatus {
    Stopped,
    Running,
    /// It could not start, or stopped by itself; `reason` is for the user.
    Failed {
        reason: String,
    },
}

/// A rule's state changed (or, from [`PortForwarder::list`], is not stopped).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardEvent {
    pub host_id: HostId,
    pub forward_id: ForwardId,
    pub status: ForwardStatus,
}

/// Where a rule listens: an address and port (on this machine, or on the
/// server for a remote forward). Serializes as `{ address, port }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Endpoint {
    pub address: String,
    pub port: u16,
}

impl Endpoint {
    pub fn new(address: impl Into<String>, port: u16) -> Self {
        Self {
            address: address.into(),
            port,
        }
    }
}

/// Why a rule could not start.
#[derive(Debug, Clone, thiserror::Error)]
pub enum ForwardError {
    #[error("port {} on {} is already in use", .0.port, .0.address)]
    PortInUse(Endpoint),
    #[error("not allowed to listen on port {} on {}", .0.port, .0.address)]
    PermissionDenied(Endpoint),
    #[error("cannot listen on {}:{}: {reason}", .at.address, .at.port)]
    Listen { at: Endpoint, reason: String },
    /// The server would not listen on a remote forward's port (taken there,
    /// or not allowed by its configuration).
    #[error("the server refused to listen on port {} on {}", .0.port, .0.address)]
    RemoteRefused(Endpoint),
    #[error("the Connection was lost")]
    ConnectionLost,
}

impl ForwardError {
    /// The listening end it is about, if any.
    pub fn endpoint(&self) -> Option<&Endpoint> {
        match self {
            Self::PortInUse(at) | Self::PermissionDenied(at) | Self::RemoteRefused(at) => Some(at),
            Self::Listen { at, .. } => Some(at),
            Self::ConnectionLost => None,
        }
    }
}

type Listener = Box<dyn Fn(ForwardEvent) + Send + Sync>;

/// Starts and stops Port forward rules and tracks their state. One per app.
pub struct PortForwarder {
    inner: Arc<Inner>,
}

struct Inner {
    state: Mutex<State>,
    listener: Option<Listener>,
}

#[derive(Default)]
struct State {
    rules: HashMap<ForwardId, Entry>,
    // Send in transition order, without holding the state lock during a callback.
    events: VecDeque<ForwardEvent>,
    dispatching: bool,
}

struct Entry {
    host: HostId,
    status: ForwardStatus,
    running: Option<Running>,
    restore: bool,
    stopped_by_user: bool,
    // A pooled Connection can be reported by several callers.
    auto_attempt: Option<(Weak<Connection>, Result<(), ForwardError>)>,
    // Serialize opening a rule, including remote requests that await the server.
    opening: Arc<AsyncMutex<()>>,
    // Stop invalidates all start requests reserved before it.
    stop_generation: u64,
}

struct Running {
    connection: Weak<Connection>,
    // Owns the listening socket, Connection and tunnels for this run.
    task: JoinHandle<()>,
}

impl Entry {
    fn new(host: &HostId) -> Self {
        Self {
            host: host.clone(),
            status: ForwardStatus::Stopped,
            running: None,
            restore: false,
            stopped_by_user: false,
            auto_attempt: None,
            opening: Arc::default(),
            stop_generation: 0,
        }
    }

    fn stop(&mut self, id: &ForwardId) -> Option<ForwardEvent> {
        self.stop_generation += 1;
        self.restore = false;
        self.stopped_by_user = true;
        self.auto_attempt = None;
        if let Some(running) = self.running.take() {
            running.task.abort();
        }
        let previous = std::mem::replace(&mut self.status, ForwardStatus::Stopped);
        (previous != ForwardStatus::Stopped).then(|| self.event(id))
    }

    fn event(&self, id: &ForwardId) -> ForwardEvent {
        ForwardEvent {
            host_id: self.host.clone(),
            forward_id: id.clone(),
            status: self.status.clone(),
        }
    }
}

impl Default for PortForwarder {
    fn default() -> Self {
        Self::new()
    }
}

impl PortForwarder {
    pub fn new() -> Self {
        Self::build(None)
    }

    /// Calls `listener` on each state change, in order, with no state lock held.
    pub fn with_listener(listener: impl Fn(ForwardEvent) + Send + Sync + 'static) -> Self {
        Self::build(Some(Box::new(listener)))
    }

    fn build(listener: Option<Listener>) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::default(),
                listener,
            }),
        }
    }

    /// Starts `rule` (one of Host `host`'s) over `connection`, which it keeps
    /// open until stopped. A rule already running on a live Connection is
    /// left as it is. Marks a rule failed if it cannot listen.
    pub fn start(
        &self,
        connection: Arc<Connection>,
        host: &HostId,
        rule: &PortForward,
    ) -> impl Future<Output = Result<(), ForwardError>> + Send + 'static {
        let request = self
            .reserve(connection, host, rule, false)
            .expect("manual starts are always reserved");
        async move {
            // Finish an in-flight remote request even if the caller closes its pane.
            // If Stop won, dropping the opened listener cancels it.
            tokio::spawn(request.open())
                .await
                .expect("Port forward setup task panicked")
        }
    }

    /// Starts the Host's auto-start rules and restores rules that lost their
    /// Connection. Call after connecting, even when sharing a pooled Connection.
    /// Results contain rules that could not start; these are also marked failed.
    pub fn start_auto(
        &self,
        connection: Arc<Connection>,
        host: &Host,
    ) -> impl Future<Output = Vec<(ForwardId, ForwardError)>> + Send + 'static {
        let requests: Vec<_> = host
            .forwards
            .iter()
            .filter_map(|rule| self.reserve(Arc::clone(&connection), &host.id, rule, true))
            .collect();
        async move {
            if requests.is_empty() {
                return Vec::new();
            }
            // Complete the Host's starts even if the pane that connected closes.
            tokio::spawn(async move {
                let mut failures = Vec::new();
                for request in requests {
                    let id = request.rule.id.clone();
                    if let Err(error) = request.open().await {
                        failures.push((id, error));
                    }
                }
                failures
            })
            .await
            .expect("Port forward setup task panicked")
        }
    }

    // The app reserves requests while reading saved rules, so deleting a rule
    // can invalidate every request that saw it before the deletion.
    fn reserve(
        &self,
        connection: Arc<Connection>,
        host: &HostId,
        rule: &PortForward,
        automatic: bool,
    ) -> Option<Start> {
        let mut state = self.inner.lock();
        if automatic && !rule.auto_start && !state.rules.contains_key(&rule.id) {
            return None;
        }
        let entry = state
            .rules
            .entry(rule.id.clone())
            .or_insert_with(|| Entry::new(host));
        if automatic && (&entry.host != host || entry.stopped_by_user) {
            return None;
        }
        Some(Start {
            inner: Arc::clone(&self.inner),
            connection,
            rule: rule.clone(),
            automatic,
            stamp: StartStamp {
                opening: Arc::clone(&entry.opening),
                stop_generation: entry.stop_generation,
            },
        })
    }

    /// Stops the rule and clears any failure. A manual start can enable it
    /// again; automatic starts are suppressed for this app run.
    pub fn stop(&self, id: &ForwardId) {
        let mut state = self.inner.lock();
        let event = state.rules.get_mut(id).and_then(|entry| entry.stop(id));
        self.inner.publish(state, event);
    }

    /// Stops and forgets a rule removed from its Host.
    pub fn forget(&self, id: &ForwardId) {
        let mut state = self.inner.lock();
        let event = state.rules.remove(id).and_then(|mut entry| entry.stop(id));
        self.inner.publish(state, event);
    }

    /// Stops every rule of Host `host` (e.g. when it is disconnected).
    pub fn stop_host(&self, host: &HostId) {
        self.clear_host(host, false);
    }

    /// Stops and forgets the rules of a deleted Host.
    pub fn forget_host(&self, host: &HostId) {
        self.clear_host(host, true);
    }

    fn clear_host(&self, host: &HostId, deleted: bool) {
        let mut state = self.inner.lock();
        let events: Vec<_> = state
            .rules
            .extract_if(|_, entry| &entry.host == host && (deleted || !entry.stopped_by_user))
            .filter_map(|(id, mut entry)| entry.stop(&id))
            .collect();
        self.inner.publish(state, events);
    }

    pub fn status(&self, id: &ForwardId) -> ForwardStatus {
        self.inner
            .lock()
            .rules
            .get(id)
            .map_or(ForwardStatus::Stopped, |e| e.status.clone())
    }

    /// Every rule that is running or failed.
    pub fn list(&self) -> Vec<ForwardEvent> {
        self.inner
            .lock()
            .rules
            .iter()
            .filter(|(_, entry)| entry.status != ForwardStatus::Stopped)
            .map(|(id, entry)| entry.event(id))
            .collect()
    }
}

impl Drop for PortForwarder {
    fn drop(&mut self) {
        for (_, entry) in self.inner.lock().rules.drain() {
            if let Some(running) = entry.running {
                running.task.abort();
            }
        }
    }
}

impl Inner {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn publish<'a>(
        &'a self,
        mut state: std::sync::MutexGuard<'a, State>,
        events: impl IntoIterator<Item = ForwardEvent>,
    ) {
        state.events.extend(events);
        if state.dispatching || state.events.is_empty() {
            return;
        }
        state.dispatching = true;
        loop {
            let Some(event) = state.events.pop_front() else {
                state.dispatching = false;
                return;
            };
            drop(state);
            let status = match &event.status {
                ForwardStatus::Stopped => "stopped",
                ForwardStatus::Running => "running",
                ForwardStatus::Failed { .. } => "failed",
            };
            log::info!(
                "Port forward host={} id={} state={status}",
                event.host_id,
                event.forward_id
            );
            if let Some(listener) = &self.listener {
                listener(event);
            }
            state = self.lock();
        }
    }
}

#[derive(Clone)]
struct StartStamp {
    opening: Arc<AsyncMutex<()>>,
    stop_generation: u64,
}

impl StartStamp {
    fn matches(&self, entry: &Entry) -> bool {
        self.stop_generation == entry.stop_generation && Arc::ptr_eq(&self.opening, &entry.opening)
    }
}

struct Start {
    inner: Arc<Inner>,
    connection: Arc<Connection>,
    rule: PortForward,
    automatic: bool,
    stamp: StartStamp,
}

impl Start {
    fn entry<'a>(&self, state: &'a mut State) -> Option<&'a mut Entry> {
        state
            .rules
            .get_mut(&self.rule.id)
            .filter(|entry| self.stamp.matches(entry))
    }

    async fn open(self) -> Result<(), ForwardError> {
        let turn = self.stamp.opening.lock().await;
        let connection = Arc::downgrade(&self.connection);
        let previous = {
            let mut state = self.inner.lock();
            let Some(entry) = self.entry(&mut state) else {
                return Ok(());
            };
            if entry
                .running
                .as_ref()
                .and_then(|running| running.connection.upgrade())
                .is_some_and(|connection| !connection.is_closed())
            {
                return Ok(());
            }
            entry.running.take()
        };
        if let Some(previous) = previous {
            // A reconnect may win the race with the previous run's periodical
            // loss check. Let it close the socket and record the interruption.
            let _ = previous.task.await;
        }

        {
            let mut state = self.inner.lock();
            let Some(entry) = self.entry(&mut state) else {
                return Ok(());
            };
            if self.automatic {
                if self.connection.is_closed()
                    || entry.stopped_by_user
                    || (!self.rule.auto_start && !entry.restore)
                {
                    return Ok(());
                }
                if let Some((_, result)) = entry
                    .auto_attempt
                    .as_ref()
                    .filter(|(previous, _)| previous.ptr_eq(&connection))
                {
                    return result.clone();
                }
            } else {
                entry.stopped_by_user = false;
            }
        }

        let opened = if self.connection.is_closed() {
            Err(ForwardError::ConnectionLost)
        } else {
            open(Arc::clone(&self.connection), &self.rule.kind).await
        };
        let mut state = self.inner.lock();
        let Some(entry) = self.entry(&mut state) else {
            return Ok(());
        };
        entry.restore &= matches!(opened, Err(ForwardError::ConnectionLost));
        let result = match opened {
            Ok(opened) => {
                let finished = Finished {
                    inner: Arc::downgrade(&self.inner),
                    id: self.rule.id.clone(),
                    stamp: self.stamp.clone(),
                };
                let task = tokio::spawn(async move {
                    let failure = opened.run().await;
                    finished.fail(failure);
                });
                entry.status = ForwardStatus::Running;
                entry.running = Some(Running {
                    connection: connection.clone(),
                    task,
                });
                Ok(())
            }
            Err(error) => {
                log_start_error(&entry.host, &self.rule.id, &error);
                entry.status = ForwardStatus::Failed {
                    reason: error.to_string(),
                };
                Err(error)
            }
        };
        entry.auto_attempt = self.automatic.then(|| (connection, result.clone()));
        let event = entry.event(&self.rule.id);
        drop(turn);
        self.inner.publish(state, Some(event));
        result
    }
}

fn log_start_error(host: &HostId, id: &ForwardId, error: &ForwardError) {
    let kind = match error {
        ForwardError::PortInUse(_) => "portInUse",
        ForwardError::PermissionDenied(_) => "permissionDenied",
        ForwardError::Listen { .. } => "listenFailed",
        ForwardError::RemoteRefused(_) => "remoteRefused",
        ForwardError::ConnectionLost => "connectionLost",
    };
    log::warn!("Port forward host={host} id={id} start error={kind}");
}

enum RunFailure {
    ConnectionLost,
    Accept(io::Error),
}

/// Marks a run failed when its task ends by itself.
struct Finished {
    inner: Weak<Inner>,
    id: ForwardId,
    stamp: StartStamp,
}

impl Finished {
    fn fail(self, failure: RunFailure) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        let mut state = inner.lock();
        let Some(entry) = state
            .rules
            .get_mut(&self.id)
            .filter(|entry| self.stamp.matches(entry))
        else {
            return;
        };
        entry.restore = matches!(failure, RunFailure::ConnectionLost);
        let reason = match failure {
            RunFailure::ConnectionLost => ForwardError::ConnectionLost.to_string(),
            RunFailure::Accept(error) => format!("stopped accepting connections: {error}"),
        };
        entry.status = ForwardStatus::Failed { reason };
        entry.running = None;
        let event = entry.event(&self.id);
        inner.publish(state, Some(event));
    }
}

/// A rule's listening end, opened; [`Opened::run`] serves it.
enum Opened {
    /// `ssh -L`: connections here go to `target` as the server sees it.
    Local {
        listener: TcpListener,
        connection: Arc<Connection>,
        target: (String, u16),
    },
    /// `ssh -D`: connections here are SOCKS5 clients; each names its target.
    Dynamic {
        listener: TcpListener,
        connection: Arc<Connection>,
    },
    /// `ssh -R`: connections the server accepts go to `target` from here.
    Remote {
        listener: RemoteListener,
        target: (String, u16),
    },
}

/// Opens `kind`'s listening end: binds the local socket, or has the server
/// listen, so a port that cannot be had fails `start` at once.
async fn open(connection: Arc<Connection>, kind: &ForwardKind) -> Result<Opened, ForwardError> {
    match kind {
        ForwardKind::Local {
            bind_address,
            bind_port,
            remote_host,
            remote_port,
        } => Ok(Opened::Local {
            listener: listen(bind_address, *bind_port)?,
            connection,
            target: (remote_host.clone(), *remote_port),
        }),
        ForwardKind::Dynamic {
            bind_address,
            bind_port,
        } => Ok(Opened::Dynamic {
            listener: listen(bind_address, *bind_port)?,
            connection,
        }),
        ForwardKind::Remote {
            bind_address,
            bind_port,
            local_host,
            local_port,
        } => {
            let listener = connection
                .listen_remote(bind_address, *bind_port)
                .await
                .map_err(|e| match e {
                    russh::Error::RequestDenied => {
                        ForwardError::RemoteRefused(Endpoint::new(bind_address, *bind_port))
                    }
                    _ => ForwardError::ConnectionLost,
                })?;
            Ok(Opened::Remote {
                listener,
                target: (local_host.clone(), *local_port),
            })
        }
    }
}

impl Opened {
    /// Serves the rule until aborted. Returns why it stopped by itself.
    async fn run(self) -> RunFailure {
        match self {
            Opened::Local {
                listener,
                connection,
                target,
            } => {
                let (host, port) = target;
                serve_local(listener, connection, move |socket, peer, connection| {
                    let host = host.clone();
                    async move { tunnel(socket, peer, &connection, &host, port).await }
                })
                .await
            }
            Opened::Dynamic {
                listener,
                connection,
            } => {
                serve_local(
                    listener,
                    connection,
                    |socket, peer, connection| async move {
                        socks::serve(socket, peer, &connection).await
                    },
                )
                .await
            }
            Opened::Remote { listener, target } => run_remote(listener, target).await,
        }
    }
}

/// Binds the listening socket now, so a taken port fails `start` at once.
fn listen(address: &str, port: u16) -> Result<TcpListener, ForwardError> {
    let error = |e: io::Error| {
        let at = Endpoint::new(address, port);
        match e.kind() {
            io::ErrorKind::AddrInUse => ForwardError::PortInUse(at),
            io::ErrorKind::PermissionDenied => ForwardError::PermissionDenied(at),
            _ => ForwardError::Listen {
                at,
                reason: e.to_string(),
            },
        }
    };
    let listener = StdListener::bind((address, port)).map_err(error)?;
    listener.set_nonblocking(true).map_err(error)?;
    TcpListener::from_std(listener).map_err(error)
}

/// Accepts connections on `listener`, serving each with `serve` over
/// `connection`, until aborted. Returns why it stopped by itself.
async fn serve_local<F, Fut>(
    listener: TcpListener,
    connection: Arc<Connection>,
    serve: F,
) -> RunFailure
where
    F: Fn(TcpStream, SocketAddr, Arc<Connection>) -> Fut,
    Fut: Future<Output = ()> + Send + 'static,
{
    let mut tunnels = JoinSet::new();
    let mut check = tokio::time::interval(CONNECTION_CHECK);
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (socket, peer) = match accepted {
                    Ok(accepted) => accepted,
                    Err(error) => return RunFailure::Accept(error),
                };
                tunnels.spawn(serve(socket, peer, Arc::clone(&connection)));
            }
            _ = check.tick() => {
                if connection.is_closed() {
                    return RunFailure::ConnectionLost;
                }
            }
            // Reap finished tunnels so the set doesn't grow.
            Some(_) = tunnels.join_next(), if !tunnels.is_empty() => {}
        }
    }
}

/// Carries every connection the server accepts on `listener` to `target`
/// on this machine until aborted. Returns why it stopped by itself.
async fn run_remote(mut listener: RemoteListener, (host, port): (String, u16)) -> RunFailure {
    let mut tunnels = JoinSet::new();
    let mut check = tokio::time::interval(CONNECTION_CHECK);
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Some(mut channel) = accepted else {
                    return if listener.connection().is_closed() {
                        RunFailure::ConnectionLost
                    } else {
                        RunFailure::Accept(io::ErrorKind::BrokenPipe.into())
                    };
                };
                let host = host.clone();
                tunnels.spawn(async move {
                    // A target that is not listening just closes the channel,
                    // like `ssh -R`.
                    let Ok(mut socket) = TcpStream::connect((host.as_str(), port)).await else {
                        return;
                    };
                    let _ = socket.set_nodelay(true);
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut channel).await;
                });
            }
            _ = check.tick() => {
                if listener.connection().is_closed() {
                    return RunFailure::ConnectionLost;
                }
            }
            Some(_) = tunnels.join_next(), if !tunnels.is_empty() => {}
        }
    }
}

/// Carries one accepted socket to `host:port`. A target the server cannot
/// reach just closes the socket, like `ssh -L`.
async fn tunnel(
    mut socket: TcpStream,
    peer: SocketAddr,
    connection: &Connection,
    host: &str,
    port: u16,
) {
    let _ = socket.set_nodelay(true);
    let Ok(mut channel) = connection.open_direct_tcpip(host, port, Some(peer)).await else {
        return;
    };
    let _ = tokio::io::copy_bidirectional(&mut socket, &mut channel).await;
}
