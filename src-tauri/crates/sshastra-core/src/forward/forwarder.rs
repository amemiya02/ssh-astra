//! Runs Port forward rules. A running rule holds its Host's Connection, so the
//! Connection stays up while any rule on it runs, even with no Terminal open;
//! stopping the last one lets it disconnect.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::net::{SocketAddr, TcpListener as StdListener};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::Serialize;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};

use super::{socks, ForwardId, ForwardKind, PortForward};
use crate::hosts::{Host, HostId};
use crate::ssh::{Connection, RemoteListener};

/// Why a rule stopped when its Connection went away.
const LOST: &str = "the Connection was lost";

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

/// Why a rule could not start.
#[derive(Debug, thiserror::Error)]
pub enum ForwardError {
    #[error("port {port} on {address} is already in use")]
    PortInUse { address: String, port: u16 },
    #[error("not allowed to listen on port {port} on {address}")]
    PermissionDenied { address: String, port: u16 },
    #[error("cannot listen on {address}:{port}: {reason}")]
    Listen {
        address: String,
        port: u16,
        reason: String,
    },
    /// The server would not listen on a remote forward's port (taken there,
    /// or not allowed by its configuration).
    #[error("the server refused to listen on port {port} on {address}")]
    RemoteRefused { address: String, port: u16 },
    #[error("the Connection was lost")]
    ConnectionLost,
}

type Listener = Box<dyn Fn(ForwardEvent) + Send + Sync>;

/// Starts and stops Port forward rules and tracks their state. One per app.
pub struct PortForwarder {
    inner: Arc<Inner>,
}

struct Inner {
    rules: Mutex<HashMap<ForwardId, Entry>>,
    listener: Option<Listener>,
}

struct Entry {
    host: HostId,
    status: ForwardStatus,
    /// The running rule's task; it owns the listening socket, the Connection
    /// and every open tunnel, so aborting it releases them all.
    task: Option<JoinHandle<()>>,
    /// Tells this run apart from earlier ones of the same rule.
    run: u64,
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

    /// Calls `listener` on every state change, from any thread, with no lock
    /// held.
    pub fn with_listener(listener: impl Fn(ForwardEvent) + Send + Sync + 'static) -> Self {
        Self::build(Some(Box::new(listener)))
    }

    fn build(listener: Option<Listener>) -> Self {
        Self {
            inner: Arc::new(Inner {
                rules: Mutex::default(),
                listener,
            }),
        }
    }

    /// Starts `rule` (one of Host `host`'s) over `connection`, which it keeps
    /// open until stopped. A running rule is left as it is. Fails, and marks
    /// the rule failed, if it cannot listen (e.g. the port is taken here, or
    /// the server refuses a remote port). Must be called within a Tokio
    /// runtime.
    pub async fn start(
        &self,
        connection: Arc<Connection>,
        host: &HostId,
        rule: &PortForward,
    ) -> Result<(), ForwardError> {
        if self.status(&rule.id) == ForwardStatus::Running {
            return Ok(());
        }
        let opened = open(connection, &rule.kind).await;
        let mut rules = self.inner.lock();
        if let Some(Entry {
            status: ForwardStatus::Running,
            ..
        }) = rules.get(&rule.id)
        {
            // Started meanwhile by another call; `opened` is dropped.
            return Ok(());
        }
        let run = rules.get(&rule.id).map_or(0, |e| e.run + 1);
        let (status, task, result) = match opened {
            Ok(opened) => {
                let finished = Finished {
                    inner: Arc::downgrade(&self.inner),
                    id: rule.id.clone(),
                    run,
                };
                let task = tokio::spawn(async move {
                    let reason = opened.run().await;
                    finished.fail(reason);
                });
                (ForwardStatus::Running, Some(task), Ok(()))
            }
            Err(e) => (
                ForwardStatus::Failed {
                    reason: e.to_string(),
                },
                None,
                Err(e),
            ),
        };
        rules.insert(
            rule.id.clone(),
            Entry {
                host: host.clone(),
                status: status.clone(),
                task,
                run,
            },
        );
        drop(rules);
        self.inner.emit(host, &rule.id, status);
        result
    }

    /// Starts every rule of `host` marked to start automatically, over its
    /// freshly made `connection`; call it whenever the Host connects. Rules
    /// already running are left as they are. Returns the rules that could
    /// not start (they are also marked failed).
    pub async fn start_auto(
        &self,
        connection: Arc<Connection>,
        host: &Host,
    ) -> Vec<(ForwardId, ForwardError)> {
        let mut failures = Vec::new();
        for rule in host.forwards.iter().filter(|rule| rule.auto_start) {
            if let Err(e) = self.start(Arc::clone(&connection), &host.id, rule).await {
                failures.push((rule.id.clone(), e));
            }
        }
        failures
    }

    /// Stops rule `id`, closing its listening socket and open tunnels and
    /// releasing its Connection. Also clears a failed rule's error.
    pub fn stop(&self, id: &ForwardId) {
        let Some(entry) = self.inner.lock().remove(id) else {
            return;
        };
        if let Some(task) = entry.task {
            task.abort();
        }
        self.inner.emit(&entry.host, id, ForwardStatus::Stopped);
    }

    /// Stops every rule of Host `host` (e.g. when it is deleted).
    pub fn stop_host(&self, host: &HostId) {
        let ids: Vec<ForwardId> = self
            .inner
            .lock()
            .iter()
            .filter(|(_, e)| &e.host == host)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.stop(&id);
        }
    }

    pub fn status(&self, id: &ForwardId) -> ForwardStatus {
        self.inner
            .lock()
            .get(id)
            .map_or(ForwardStatus::Stopped, |e| e.status.clone())
    }

    /// Every rule that is running or failed.
    pub fn list(&self) -> Vec<ForwardEvent> {
        self.inner
            .lock()
            .iter()
            .map(|(id, e)| ForwardEvent {
                host_id: e.host.clone(),
                forward_id: id.clone(),
                status: e.status.clone(),
            })
            .collect()
    }
}

impl Drop for PortForwarder {
    fn drop(&mut self) {
        for entry in self.inner.lock().values_mut() {
            if let Some(task) = entry.task.take() {
                task.abort();
            }
        }
    }
}

impl Inner {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<ForwardId, Entry>> {
        self.rules.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn emit(&self, host: &HostId, id: &ForwardId, status: ForwardStatus) {
        if let Some(listener) = &self.listener {
            listener(ForwardEvent {
                host_id: host.clone(),
                forward_id: id.clone(),
                status,
            });
        }
    }
}

/// Marks a run failed when its task ends by itself.
struct Finished {
    inner: Weak<Inner>,
    id: ForwardId,
    run: u64,
}

impl Finished {
    fn fail(self, reason: String) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        let mut rules = inner.lock();
        let Some(entry) = rules.get_mut(&self.id).filter(|e| e.run == self.run) else {
            return;
        };
        let status = ForwardStatus::Failed { reason };
        entry.status = status.clone();
        entry.task = None;
        let host = entry.host.clone();
        drop(rules);
        inner.emit(&host, &self.id, status);
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
                    russh::Error::RequestDenied => ForwardError::RemoteRefused {
                        address: bind_address.clone(),
                        port: *bind_port,
                    },
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
    async fn run(self) -> String {
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
    let error = |e: io::Error| match e.kind() {
        io::ErrorKind::AddrInUse => ForwardError::PortInUse {
            address: address.to_owned(),
            port,
        },
        io::ErrorKind::PermissionDenied => ForwardError::PermissionDenied {
            address: address.to_owned(),
            port,
        },
        _ => ForwardError::Listen {
            address: address.to_owned(),
            port,
            reason: e.to_string(),
        },
    };
    let listener = StdListener::bind((address, port)).map_err(error)?;
    listener.set_nonblocking(true).map_err(error)?;
    TcpListener::from_std(listener).map_err(error)
}

/// Accepts connections on `listener`, serving each with `serve` over
/// `connection`, until aborted. Returns why it stopped by itself.
async fn serve_local<F, Fut>(listener: TcpListener, connection: Arc<Connection>, serve: F) -> String
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
                    Err(e) => return format!("stopped accepting connections: {e}"),
                };
                tunnels.spawn(serve(socket, peer, Arc::clone(&connection)));
            }
            _ = check.tick() => {
                if connection.is_closed() {
                    return LOST.to_owned();
                }
            }
            // Reap finished tunnels so the set doesn't grow.
            Some(_) = tunnels.join_next(), if !tunnels.is_empty() => {}
        }
    }
}

/// Carries every connection the server accepts on `listener` to `target`
/// on this machine until aborted. Returns why it stopped by itself.
async fn run_remote(mut listener: RemoteListener, (host, port): (String, u16)) -> String {
    let mut tunnels = JoinSet::new();
    let mut check = tokio::time::interval(CONNECTION_CHECK);
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Some(mut channel) = accepted else {
                    return LOST.to_owned();
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
                    return LOST.to_owned();
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
