//! Host commands: the saved Host list (HostStore).

use std::sync::Mutex;

use sshastra_core::hosts::{Host, HostDraft, HostId, HostStore};
use tauri::State;

use crate::error::{CommandError, CommandResult};

/// The HostStore, or why it could not be loaded at startup (e.g. a damaged
/// file, which is left untouched rather than overwritten).
pub struct HostsState(Mutex<Result<HostStore, CommandError>>);

impl HostsState {
    pub fn new(store: Result<HostStore, CommandError>) -> Self {
        Self(Mutex::new(store))
    }

    pub fn with<T>(&self, f: impl FnOnce(&mut HostStore) -> CommandResult<T>) -> CommandResult<T> {
        let mut guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_mut() {
            Ok(store) => f(store),
            Err(e) => Err(e.clone()),
        }
    }
}

#[tauri::command]
pub fn hosts_list(hosts: State<'_, HostsState>) -> CommandResult<Vec<Host>> {
    hosts.with(|store| Ok(store.list().to_vec()))
}

/// Adds a Host (`id` omitted) or replaces the Host with `id`.
#[tauri::command]
pub fn host_save(
    hosts: State<'_, HostsState>,
    id: Option<HostId>,
    draft: HostDraft,
) -> CommandResult<Host> {
    hosts.with(|store| Ok(store.upsert(id, draft)?))
}

#[tauri::command]
pub fn host_delete(hosts: State<'_, HostsState>, id: HostId) -> CommandResult<()> {
    hosts.with(|store| Ok(store.delete(&id)?))
}
