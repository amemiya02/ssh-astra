//! Runs Port forward rules. A running rule holds its Host's Connection, so the
//! Connection stays up while any rule on it runs, even with no Terminal open;
//! stopping the last one lets it disconnect.

use std::collections::HashMap;
use std::io;
use std::net::TcpListener as StdListener;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::Serialize;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};

use super::{ForwardId, ForwardKind, PortForward};
use crate::hosts::HostId;
use crate::ssh::Connection;

/// How often a running rule checks that its Connection is still up.
const CONNECTION_CHECK: Duration = Duration::from_secs(1);

/// A rule's state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ForwardStatus {
    Stopped,
    Running,
    /// It could not start, or stopped by itself; `reason` is for the user.
    Failed { reason: String },
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
    /// the rule failed, if it cannot listen (e.g. the port is taken). Must be
    /// called within a Tokio runtime.
    pub fn start(
        &self,
        connection: Arc<Connection>,
        host: &HostId,
        rule: &PortForward,
    ) -> Result<(), ForwardError> {
        let mut rules = self.inner.lock();
        if let Some(Entry {
            status: ForwardStatus::Running,
            ..
        }) = rules.get(&rule.id)
        {
            return Ok(());
        }
        let run = rules.get(&rule.id).map_or(0, |e| e.run + 1);
        let started = match &rule.kind {
            ForwardKind::Local {
                bind_address,
                bind_port,
                remote_host,
                remote_port,
            } => listen(bind_address, *bind_port).map(|listener| {
                let target = (remote_host.clone(), *remote_port);
                let finished = Finished {
                    inner: Arc::downgrade(&self.inner),
                    id: rule.id.clone(),
                    run,
                };
                tokio::spawn(async move {
                    let reason = run_local(listener, connection, target).await;
                    finished.fail(reason);
                })
            }),
        };
        let (status, task, result) = match started {
            Ok(task) => (ForwardStatus::Running, Some(task), Ok(())),
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

/// Accepts connections on `listener` and carries each to `target` through
/// `connection` until aborted. Returns why it stopped by itself.
async fn run_local(
    listener: TcpListener,
    connection: Arc<Connection>,
    (host, port): (String, u16),
) -> String {
    let mut tunnels = JoinSet::new();
    let mut check = tokio::time::interval(CONNECTION_CHECK);
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (socket, peer) = match accepted {
                    Ok(accepted) => accepted,
                    Err(e) => return format!("stopped accepting connections: {e}"),
                };
                let connection = Arc::clone(&connection);
                let host = host.clone();
                tunnels.spawn(async move {
                    tunnel(socket, peer, &connection, &host, port).await;
                });
            }
            _ = check.tick() => {
                if connection.is_closed() {
                    return "the Connection was lost".to_owned();
                }
            }
            // Reap finished tunnels so the set doesn't grow.
            Some(_) = tunnels.join_next(), if !tunnels.is_empty() => {}
        }
    }
}

/// Carries one accepted socket to `host:port`. A target the server cannot
/// reach just closes the socket, like `ssh -L`.
async fn tunnel(
    mut socket: TcpStream,
    peer: std::net::SocketAddr,
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
