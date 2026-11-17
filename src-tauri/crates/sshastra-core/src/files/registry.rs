use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::RemoteFs;

/// Identifies an open remote file system (one per File panel) across the IPC
/// boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct FsId(u64);

/// Every open remote file system, addressed by [`FsId`]. Each keeps its
/// Connection open until [`remove`](Self::remove)d (and no request on it is
/// still running).
#[derive(Default)]
pub struct FsRegistry {
    next_id: AtomicU64,
    open: Mutex<HashMap<FsId, Arc<dyn RemoteFs>>>,
}

impl FsRegistry {
    pub fn insert(&self, fs: Arc<dyn RemoteFs>) -> FsId {
        let id = FsId(self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        self.lock().insert(id, fs);
        id
    }

    pub fn get(&self, id: FsId) -> Option<Arc<dyn RemoteFs>> {
        self.lock().get(&id).cloned()
    }

    /// Forgets the file system; `false` if it was not open.
    pub fn remove(&self, id: FsId) -> bool {
        self.lock().remove(&id).is_some()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<FsId, Arc<dyn RemoteFs>>> {
        self.open.lock().unwrap_or_else(|p| p.into_inner())
    }
}
