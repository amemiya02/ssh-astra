//! Connections kept open on their own ("connect only"): no Terminal or Port
//! forward needs them, the user just wants the Host connected.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::Serialize;
use tokio::task::JoinHandle;

use super::Connection;
use crate::hosts::HostId;

/// How often a held Connection is checked for having dropped.
const CHECK: Duration = Duration::from_secs(1);

/// A Host's Connection started or stopped being held.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldEvent {
    pub host_id: HostId,
    pub held: bool,
}

type Listener = Box<dyn Fn(HeldEvent) + Send + Sync>;

/// Holds one Connection per Host open until released or until it drops by
/// itself (then it is let go and reported, not reconnected). One per app.
pub struct HeldConnections {
    inner: Arc<Inner>,
}

struct Inner {
    held: Mutex<HashMap<HostId, Held>>,
    listener: Option<Listener>,
}

struct Held {
    /// Owns the Connection; aborting it lets the Connection go.
    task: JoinHandle<()>,
    /// Tells this hold apart from later ones on the same Host.
    run: u64,
}

impl Default for HeldConnections {
    fn default() -> Self {
        Self::new()
    }
}

impl HeldConnections {
    pub fn new() -> Self {
        Self::build(None)
    }

    /// Calls `listener` on every change, from any thread, with no lock held.
    pub fn with_listener(listener: impl Fn(HeldEvent) + Send + Sync + 'static) -> Self {
        Self::build(Some(Box::new(listener)))
    }

    fn build(listener: Option<Listener>) -> Self {
        Self {
            inner: Arc::new(Inner {
                held: Mutex::default(),
                listener,
            }),
        }
    }

    /// Keeps `connection` (Host `host`'s) open, replacing any earlier hold on
    /// that Host. Must be called within a Tokio runtime.
    pub fn hold(&self, host: &HostId, connection: Arc<Connection>) {
        let mut held = self.inner.lock();
        let run = held.get(host).map_or(0, |h| h.run + 1);
        let watcher = Arc::downgrade(&self.inner);
        let id = host.clone();
        let task = tokio::spawn(async move {
            let mut check = tokio::time::interval(CHECK);
            while !connection.is_closed() {
                check.tick().await;
            }
            drop(connection);
            Inner::dropped(&watcher, &id, run);
        });
        if let Some(previous) = held.insert(host.clone(), Held { task, run }) {
            previous.task.abort();
        }
        drop(held);
        self.inner.emit(host, true);
    }

    /// Lets Host `host`'s held Connection go; it disconnects unless a
    /// Terminal or Port forward still uses it.
    pub fn release(&self, host: &HostId) {
        let Some(held) = self.inner.lock().remove(host) else {
            return;
        };
        held.task.abort();
        self.inner.emit(host, false);
    }

    /// The Hosts whose Connection is held.
    pub fn list(&self) -> Vec<HostId> {
        self.inner.lock().keys().cloned().collect()
    }
}

impl Drop for HeldConnections {
    fn drop(&mut self) {
        for held in self.inner.lock().values() {
            held.task.abort();
        }
    }
}

impl Inner {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<HostId, Held>> {
        self.held.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn emit(&self, host: &HostId, held: bool) {
        if let Some(listener) = &self.listener {
            listener(HeldEvent {
                host_id: host.clone(),
                held,
            });
        }
    }

    /// Hold `run` on `host` ended because its Connection dropped.
    fn dropped(inner: &Weak<Inner>, host: &HostId, run: u64) {
        let Some(inner) = inner.upgrade() else {
            return;
        };
        let mut held = inner.lock();
        if held.get(host).is_none_or(|h| h.run != run) {
            return;
        }
        held.remove(host);
        drop(held);
        inner.emit(host, false);
    }
}
