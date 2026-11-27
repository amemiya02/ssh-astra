//! Host commands: the saved Host list (HostStore) with its Groups.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use sshastra_core::hosts::{
    Bookmark, DetectedOs, Group, GroupId, Host, HostDraft, HostId, HostStore, HostTree, ImportReport,
    ImportSummary,
};
use sshastra_core::ssh_config::{parse_user_config, ParseContext};
use tauri::{ipc::Channel, State};

use super::connections::ConnectionsState;
use super::forwards::ForwardsState;
use super::watch::Watcher;
use crate::commands::credentials::Vault;
use crate::error::{CommandError, CommandResult};

/// The HostStore, or why it could not be loaded at startup (e.g. a damaged
/// file, which is left untouched rather than overwritten).
pub struct HostsState {
    store: Mutex<Result<HostStore, CommandError>>,
    os_changes: Watcher<HostOsChange>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostOsChange {
    host_id: HostId,
    detected_os: Option<DetectedOs>,
}

impl HostsState {
    pub fn new(store: Result<HostStore, CommandError>) -> Self {
        Self {
            store: Mutex::new(store),
            os_changes: Watcher::default(),
        }
    }

    pub fn with<T>(&self, f: impl FnOnce(&mut HostStore) -> CommandResult<T>) -> CommandResult<T> {
        let mut guard = self.store.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_mut() {
            Ok(store) => f(store),
            Err(e) => Err(e.clone()),
        }
    }

    pub(super) fn publish_os_change(&self, host_id: HostId, detected_os: Option<DetectedOs>) {
        self.os_changes.send(HostOsChange {
            host_id,
            detected_os,
        });
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
pub fn host_bookmark_add(
    hosts: State<'_, HostsState>,
    host_id: HostId,
    path: String,
) -> CommandResult<Bookmark> {
    hosts.with(|store| Ok(store.add_bookmark(&host_id, &path)?))
}

#[tauri::command]
pub fn host_bookmark_rename(
    hosts: State<'_, HostsState>,
    host_id: HostId,
    path: String,
    name: String,
) -> CommandResult<Bookmark> {
    hosts.with(|store| Ok(store.rename_bookmark(&host_id, &path, &name)?))
}

#[tauri::command]
pub fn host_bookmark_delete(
    hosts: State<'_, HostsState>,
    host_id: HostId,
    path: String,
) -> CommandResult<()> {
    hosts.with(|store| Ok(store.delete_bookmark(&host_id, &path)?))
}

/// Deletes a Host, stopping its running Port forwards and, in the background,
/// clearing its saved credentials.
#[tauri::command]
pub fn host_delete(
    hosts: State<'_, HostsState>,
    forwards: State<'_, ForwardsState>,
    connections: State<'_, ConnectionsState>,
    vault: State<'_, Vault>,
    id: HostId,
) -> CommandResult<()> {
    hosts.with(|store| Ok(store.delete(&id)?))?;
    forwards.forwarder.stop_host(&id);
    connections.release(&id);
    let vault = Vault::clone(&vault);
    // Best effort: an entry left behind is unreachable, never shown again.
    tauri::async_runtime::spawn(async move { vault.clear(id).await });
    Ok(())
}

/// Every Group and Host, siblings in display order.
#[tauri::command]
pub fn host_tree(hosts: State<'_, HostsState>) -> CommandResult<HostTree> {
    hosts.with(|store| Ok(store.tree()))
}

/// Returns the Host tree and streams subsequent changes to its detected operating systems.
#[tauri::command]
pub fn host_tree_watch(
    hosts: State<'_, HostsState>,
    on_os_change: Channel<HostOsChange>,
) -> CommandResult<HostTree> {
    hosts.with(|store| Ok(hosts.os_changes.subscribe(on_os_change, || store.tree())))
}

/// Saves a copy of a Host as `name`, right after the original.
#[tauri::command]
pub fn host_duplicate(
    hosts: State<'_, HostsState>,
    id: HostId,
    name: String,
) -> CommandResult<Host> {
    hosts.with(|store| Ok(store.duplicate_host(&id, &name)?))
}

/// Moves a Host into `group_id` (`None`: the top level) at `index`.
#[tauri::command]
pub fn host_move(
    hosts: State<'_, HostsState>,
    id: HostId,
    group_id: Option<GroupId>,
    index: usize,
) -> CommandResult<HostTree> {
    hosts.with(|store| {
        store.move_host(&id, group_id, index)?;
        Ok(store.tree())
    })
}

#[tauri::command]
pub fn group_create(
    hosts: State<'_, HostsState>,
    name: String,
    parent_id: Option<GroupId>,
) -> CommandResult<Group> {
    hosts.with(|store| Ok(store.create_group(&name, parent_id)?))
}

#[tauri::command]
pub fn group_rename(
    hosts: State<'_, HostsState>,
    id: GroupId,
    name: String,
) -> CommandResult<Group> {
    hosts.with(|store| Ok(store.rename_group(&id, &name)?))
}

/// Deletes a Group; its contents move up into its parent.
#[tauri::command]
pub fn group_delete(hosts: State<'_, HostsState>, id: GroupId) -> CommandResult<HostTree> {
    hosts.with(|store| {
        store.delete_group(&id)?;
        Ok(store.tree())
    })
}

/// Moves a Group under `parent_id` (`None`: the top level) at `index`.
#[tauri::command]
pub fn group_move(
    hosts: State<'_, HostsState>,
    id: GroupId,
    parent_id: Option<GroupId>,
    index: usize,
) -> CommandResult<HostTree> {
    hosts.with(|store| {
        store.move_group(&id, parent_id, index)?;
        Ok(store.tree())
    })
}

/// The Host list after an import, and what the import did.
#[derive(Serialize)]
pub struct SshConfigImport {
    tree: HostTree,
    report: ImportReport,
}

/// Imports the Hosts in the user's `~/.ssh/config` (with its `Include`s),
/// skipping names already taken. A missing file imports nothing.
#[tauri::command]
pub fn hosts_import_ssh_config(hosts: State<'_, HostsState>) -> CommandResult<SshConfigImport> {
    let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty());
    let home = var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or_else(|| std::io::Error::other("no home directory"))?;
    let local_user = var(if cfg!(windows) { "USERNAME" } else { "USER" })
        .map(|u| u.to_string_lossy().into_owned())
        .unwrap_or_else(|| "root".to_owned());
    let parsed = parse_user_config(&home, &ParseContext { local_user })?;
    hosts.with(|store| {
        let report = store.import_ssh_config(parsed)?;
        Ok(SshConfigImport {
            tree: store.tree(),
            report,
        })
    })
}

/// Writes the whole Host list (no credentials) as an export file at `path`.
#[tauri::command]
pub fn hosts_export(hosts: State<'_, HostsState>, path: PathBuf) -> CommandResult<()> {
    hosts.with(|store| Ok(store.export_to(&path)?))
}

/// What `hosts_import` added, and the Host list afterwards.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    summary: ImportSummary,
    tree: HostTree,
}

/// Adds the Groups and Hosts of the export file at `path`; Hosts whose name
/// is taken are skipped.
#[tauri::command]
pub fn hosts_import(hosts: State<'_, HostsState>, path: PathBuf) -> CommandResult<ImportResult> {
    hosts.with(|store| {
        let summary = store.import_from(&path)?;
        Ok(ImportResult {
            summary,
            tree: store.tree(),
        })
    })
}
