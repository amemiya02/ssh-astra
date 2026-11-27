use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use super::RemoteFs;

/// Identifies an open remote file system (one per File panel) across the IPC
/// boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct FsId(u64);

struct OpenFs {
    fs: Arc<dyn RemoteFs>,
    scans: HashMap<u64, oneshot::Sender<()>>,
}

/// Every open remote file system, addressed by [`FsId`]. Each keeps its
/// Connection open until [`remove`](Self::remove)d (and no request on it is
/// still running).
#[derive(Default)]
pub struct FsRegistry {
    next_id: AtomicU64,
    next_scan: AtomicU64,
    open: Mutex<HashMap<FsId, OpenFs>>,
}

impl FsRegistry {
    pub fn insert(&self, fs: Arc<dyn RemoteFs>) -> FsId {
        let id = FsId(self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        self.lock().insert(
            id,
            OpenFs {
                fs,
                scans: HashMap::new(),
            },
        );
        id
    }

    pub fn get(&self, id: FsId) -> Option<Arc<dyn RemoteFs>> {
        self.lock().get(&id).map(|open| Arc::clone(&open.fs))
    }

    /// Registers cancellation before returning the request ID to the File panel.
    pub fn start_scan(&self, id: FsId) -> Option<(u64, Arc<dyn RemoteFs>, oneshot::Receiver<()>)> {
        let mut registry = self.lock();
        let open = registry.get_mut(&id)?;
        let request = self.next_scan.fetch_add(1, Ordering::Relaxed) + 1;
        let (cancel, cancelled) = oneshot::channel();
        open.scans.insert(request, cancel);
        Some((request, Arc::clone(&open.fs), cancelled))
    }

    /// Drops the cancellation sender, if the scan is still registered.
    pub fn cancel_scan(&self, id: FsId, request: u64) {
        if let Some(open) = self.lock().get_mut(&id) {
            open.scans.remove(&request);
        }
    }

    /// Forgets the file system and cancels its pending scans.
    /// Returns `false` if it was not open.
    pub fn remove(&self, id: FsId) -> bool {
        self.lock().remove(&id).is_some()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<FsId, OpenFs>> {
        self.open.lock().unwrap_or_else(|p| p.into_inner())
    }
}
