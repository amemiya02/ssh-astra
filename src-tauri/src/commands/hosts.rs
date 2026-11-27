//! Host commands: the saved Host list (HostStore) with its Groups.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sshastra_core::agent::{OpenTerminal, TerminalOrigin};
use sshastra_core::host_import::{parse_csv, parse_putty, ParsedConfig};
use sshastra_core::hosts::{
    Bookmark, Group, GroupId, Host, HostDraft, HostId, HostStore, HostTree, ImportReport,
    ImportSummary,
};
use sshastra_core::ssh_config::{parse_user_config, ParseContext};
use sshastra_core::terminal::{CommandHistory, TerminalRegistry};
use tauri::{ipc::Channel, State, WebviewWindow};

use super::connections::ConnectionsState;
use super::forwards::ForwardsState;
use super::watch::Watcher;
use crate::commands::credentials::Vault;
use crate::error::{CommandError, CommandResult};

/// The HostStore, or why it could not be loaded at startup (e.g. a damaged
/// file, which is left untouched rather than overwritten).
pub struct HostsState {
    store: Arc<Mutex<Result<HostStore, CommandError>>>,
    changes: Watcher<HostTreeChange>,
}

#[derive(Clone, Serialize)]
pub struct HostTreeChange {
    tree: HostTree,
}

#[derive(Serialize)]
pub struct SharedHostTree {
    #[serde(flatten)]
    tree: HostTree,
    shared: bool,
}

impl HostsState {
    pub fn new(store: Result<HostStore, CommandError>) -> Self {
        Self {
            store: Arc::new(Mutex::new(store)),
            changes: Watcher::default(),
        }
    }

    pub fn with<T>(&self, f: impl FnOnce(&mut HostStore) -> CommandResult<T>) -> CommandResult<T> {
        let mut guard = self.store.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_mut() {
            Ok(store) => f(store),
            Err(e) => Err(e.clone()),
        }
    }

    /// Publish the committed tree in the same order as its writes.
    pub(super) fn edit<T>(
        &self,
        f: impl FnOnce(&mut HostStore) -> CommandResult<T>,
    ) -> CommandResult<T> {
        self.with(|store| {
            let result = f(store)?;
            self.changes.send(HostTreeChange { tree: store.tree() });
            Ok(result)
        })
    }

    pub(crate) fn unwatch(&self, label: &str) {
        self.changes.unsubscribe(label);
    }

    pub(crate) fn agent_terminals(
        &self,
        registry: TerminalRegistry,
    ) -> impl Fn() -> Vec<OpenTerminal> + Send + Sync + 'static {
        let hosts = Arc::clone(&self.store);
        move || {
            let guard = hosts.lock().unwrap_or_else(|p| p.into_inner());
            let Ok(store) = guard.as_ref() else {
                return Vec::new();
            };
            registry
                .saved_terminals()
                .into_iter()
                .filter_map(|(id, metadata)| {
                    let host = store.get(&metadata.host)?;
                    if host.agent_access.is_off() {
                        return None;
                    }
                    let state = metadata.snapshot();
                    Some(OpenTerminal {
                        id,
                        origin: TerminalOrigin::Saved {
                            name: host.name.clone(),
                            permission: host.agent_access,
                        },
                        title: state.title,
                        cwd: state.cwd,
                        status: state.status?,
                    })
                })
                .collect()
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
    hosts.edit(|store| Ok(store.upsert(id, draft)?))
}

#[tauri::command]
pub fn host_bookmark_add(
    hosts: State<'_, HostsState>,
    host_id: HostId,
    path: String,
) -> CommandResult<Bookmark> {
    hosts.edit(|store| Ok(store.add_bookmark(&host_id, &path)?))
}

#[tauri::command]
pub fn host_bookmark_rename(
    hosts: State<'_, HostsState>,
    host_id: HostId,
    path: String,
    name: String,
) -> CommandResult<Bookmark> {
    hosts.edit(|store| Ok(store.rename_bookmark(&host_id, &path, &name)?))
}

#[tauri::command]
pub fn host_bookmark_delete(
    hosts: State<'_, HostsState>,
    host_id: HostId,
    path: String,
) -> CommandResult<()> {
    hosts.edit(|store| Ok(store.delete_bookmark(&host_id, &path)?))
}

/// Deletes a Host and its Command history, stopping its running Port forwards
/// and, in the background, clearing its saved credentials.
#[tauri::command]
pub fn host_delete(
    hosts: State<'_, HostsState>,
    forwards: State<'_, ForwardsState>,
    connections: State<'_, ConnectionsState>,
    vault: State<'_, Vault>,
    history: State<'_, CommandHistory>,
    id: HostId,
) -> CommandResult<()> {
    hosts.edit(|store| {
        store.delete(&id)?;
        if let Err(error) = history.clear(&id) {
            log::warn!(
                "Could not remove Command history for a deleted Host: {:?}",
                error.kind()
            );
        }
        Ok(())
    })?;
    forwards.forwarder.forget_host(&id);
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

/// Returns the saved tree and streams all later edits to this Window.
#[tauri::command]
pub fn host_tree_watch(
    window: WebviewWindow,
    hosts: State<'_, HostsState>,
    on_change: Channel<HostTreeChange>,
) -> CommandResult<SharedHostTree> {
    hosts.with(|store| {
        Ok(hosts
            .changes
            .subscribe(window.label(), on_change, || SharedHostTree {
                tree: store.tree(),
                shared: true,
            }))
    })
}

/// Saves a copy of a Host as `name`, right after the original.
#[tauri::command]
pub fn host_duplicate(
    hosts: State<'_, HostsState>,
    id: HostId,
    name: String,
) -> CommandResult<Host> {
    hosts.edit(|store| Ok(store.duplicate_host(&id, &name)?))
}

/// Moves a Host into `group_id` (`None`: the top level) at `index`.
#[tauri::command]
pub fn host_move(
    hosts: State<'_, HostsState>,
    id: HostId,
    group_id: Option<GroupId>,
    index: usize,
) -> CommandResult<HostTree> {
    hosts.edit(|store| {
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
    hosts.edit(|store| Ok(store.create_group(&name, parent_id)?))
}

#[tauri::command]
pub fn group_rename(
    hosts: State<'_, HostsState>,
    id: GroupId,
    name: String,
) -> CommandResult<Group> {
    hosts.edit(|store| Ok(store.rename_group(&id, &name)?))
}

/// Deletes a Group; its contents move up into its parent.
#[tauri::command]
pub fn group_delete(hosts: State<'_, HostsState>, id: GroupId) -> CommandResult<HostTree> {
    hosts.edit(|store| {
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
    hosts.edit(|store| {
        store.move_group(&id, parent_id, index)?;
        Ok(store.tree())
    })
}

/// The Host list after an import, and what the import did.
#[derive(Serialize)]
pub struct SourceImportResult {
    tree: HostTree,
    report: ImportReport,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HostImportSource {
    SshConfig,
    Csv { path: PathBuf },
    Putty { path: PathBuf },
}

/// Reads the selected source, then saves its parsed Hosts in one import.
#[tauri::command]
pub async fn hosts_import_source(
    hosts: State<'_, HostsState>,
    source: HostImportSource,
) -> CommandResult<SourceImportResult> {
    let parsed = tauri::async_runtime::spawn_blocking(move || match source {
        HostImportSource::SshConfig => read_ssh_config(),
        HostImportSource::Csv { path } => {
            std::fs::read_to_string(path).map(|text| parse_csv(&text))
        }
        HostImportSource::Putty { path } => {
            std::fs::read(path).map(|bytes| parse_putty(&bytes, &local_username()))
        }
    })
    .await
    .map_err(std::io::Error::other)??;
    hosts.edit(|store| {
        let report = store.import_config(parsed)?;
        Ok(SourceImportResult {
            tree: store.tree(),
            report,
        })
    })
}

/// A missing `~/.ssh/config` imports nothing.
fn read_ssh_config() -> std::io::Result<ParsedConfig> {
    let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty());
    let home = var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or_else(|| std::io::Error::other("no home directory"))?;
    parse_user_config(
        &home,
        &ParseContext {
            local_user: local_username(),
        },
    )
}

fn local_username() -> String {
    std::env::var_os(if cfg!(windows) { "USERNAME" } else { "USER" })
        .filter(|user| !user.is_empty())
        .map(|user| user.to_string_lossy().into_owned())
        .unwrap_or_else(|| "root".to_owned())
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
    hosts.edit(|store| {
        let summary = store.import_from(&path)?;
        Ok(ImportResult {
            summary,
            tree: store.tree(),
        })
    })
}
