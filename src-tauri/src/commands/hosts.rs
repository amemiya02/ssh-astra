//! Host commands: the saved Host list (HostStore) with its Groups.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sshastra_core::agent::{AgentPermission, OpenTerminal, TerminalOrigin};
use sshastra_core::host_import::{
    parse_csv, parse_mobaxterm, parse_putty, parse_securecrt, parse_xshell, ImportIssue,
    ImportProblem, ParsedConfig, SECURECRT_NON_SESSION_FILES,
};
use sshastra_core::hosts::{
    Bookmark, Group, GroupId, Host, HostDraft, HostId, HostStore, HostTree, ImportReport,
    ImportSummary,
};
use sshastra_core::ssh_config::{parse_user_config, ParseContext};
use sshastra_core::terminal::{CommandHistory, TerminalRegistry};
use tauri::{ipc::Channel, State, WebviewWindow};
use tokio::sync::watch;

use super::connections::ConnectionsState;
use super::forwards::ForwardsState;
use super::session_folder::{read_session_folder, SkipReason};
use super::ssh_config_export::OpenSshSync;
use super::watch::Watcher;
use crate::commands::credentials::Vault;
use crate::error::{CommandError, CommandResult};

/// The HostStore, or why it could not be loaded at startup (e.g. a damaged
/// file, which is left untouched rather than overwritten).
#[derive(Clone)]
pub struct HostsState {
    store: Arc<Mutex<Result<HostStore, CommandError>>>,
    changes: Arc<Watcher<HostTreeChange>>,
    open_ssh: Arc<OpenSshSync>,
    approvals: Arc<Mutex<HashMap<HostId, watch::Sender<()>>>>,
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
    pub fn new(store: Result<HostStore, CommandError>, open_ssh: OpenSshSync) -> Self {
        Self {
            store: Arc::new(Mutex::new(store)),
            changes: Arc::default(),
            open_ssh: Arc::new(open_ssh),
            approvals: Arc::default(),
        }
    }

    pub(super) fn open_ssh(&self) -> &OpenSshSync {
        &self.open_ssh
    }

    pub(super) fn with_export_hosts<T>(&self, f: impl FnOnce(Option<&[Host]>) -> T) -> T {
        let guard = self.store.lock().unwrap_or_else(|p| p.into_inner());
        f(guard.as_ref().ok().map(HostStore::list))
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
            self.approvals
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .retain(|id, pending| {
                    pending.receiver_count() != 0
                        && store
                            .get(id)
                            .is_some_and(|host| host.agent_access == AgentPermission::Approval)
                });
            self.changes.send(HostTreeChange { tree: store.tree() });
            self.open_ssh.rebuild(store.list(), None);
            Ok(result)
        })
    }

    /// A revocation closes the receiver even if permission is then granted again.
    pub(super) fn watch_agent_approval(&self, id: &HostId) -> Option<watch::Receiver<()>> {
        self.with(|store| {
            if !store
                .get(id)
                .is_some_and(|host| host.agent_access == AgentPermission::Approval)
            {
                return Ok(None);
            }
            let mut pending = self.approvals.lock().unwrap_or_else(|p| p.into_inner());
            pending.retain(|_, watch| watch.receiver_count() != 0);
            Ok(Some(
                pending
                    .entry(id.clone())
                    .or_insert_with(|| watch::Sender::new(()))
                    .subscribe(),
            ))
        })
        .ok()
        .flatten()
    }

    pub(crate) fn unwatch(&self, label: &str) {
        self.changes.unsubscribe(label);
        self.open_ssh.forget_preview(label);
    }

    pub(crate) fn agent_terminals(&self, registry: &TerminalRegistry) -> Vec<OpenTerminal> {
        self.with(|store| {
            Ok(registry
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
                .collect())
        })
        .unwrap_or_default()
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
    Mobaxterm { path: PathBuf },
    Xshell { path: PathBuf },
    Securecrt { path: PathBuf },
}

/// Reads the selected source, then saves its parsed Hosts in one import.
#[tauri::command]
pub async fn hosts_import_source(
    hosts: State<'_, HostsState>,
    source: HostImportSource,
) -> CommandResult<SourceImportResult> {
    let parsed = tauri::async_runtime::spawn_blocking(move || read_import_source(source))
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

fn read_import_source(source: HostImportSource) -> std::io::Result<ParsedConfig> {
    match source {
        HostImportSource::SshConfig => read_ssh_config(),
        HostImportSource::Csv { path } => {
            std::fs::read_to_string(path).map(|text| parse_csv(&text))
        }
        HostImportSource::Putty { path } => {
            std::fs::read(path).map(|bytes| parse_putty(&bytes, &local_username()))
        }
        HostImportSource::Mobaxterm { path } => {
            std::fs::read(path).map(|bytes| parse_mobaxterm(&bytes, &local_username()))
        }
        HostImportSource::Xshell { path } => read_import_folder(&path, SessionFolderSource::Xshell),
        HostImportSource::Securecrt { path } => {
            read_import_folder(&path, SessionFolderSource::Securecrt)
        }
    }
}

enum SessionFolderSource {
    Xshell,
    Securecrt,
}

fn read_import_folder(path: &Path, source: SessionFolderSource) -> std::io::Result<ParsedConfig> {
    let (snapshot, unreadable, limit) = match source {
        SessionFolderSource::Xshell => (
            read_session_folder(path, "xsh", &[])?,
            ImportProblem::XshellFile,
            ImportProblem::XshellFolderLimit,
        ),
        SessionFolderSource::Securecrt => (
            read_session_folder(path, "ini", &SECURECRT_NON_SESSION_FILES)?,
            ImportProblem::SecurecrtFile,
            ImportProblem::SecurecrtFolderLimit,
        ),
    };
    let files = snapshot
        .files
        .iter()
        .map(|(path, bytes)| (path.as_path(), bytes.as_slice()));
    let local_user = local_username();
    let mut parsed = match source {
        SessionFolderSource::Xshell => parse_xshell(files, &local_user),
        SessionFolderSource::Securecrt => parse_securecrt(files, &local_user),
    };
    parsed
        .issues
        .extend(snapshot.skipped.into_iter().map(|(path, reason)| {
            ImportIssue {
                entry: path
                    .iter()
                    .map(|part| part.to_str())
                    .collect::<Option<Vec<_>>>()
                    .map(|parts| parts.join("/"))
                    .filter(|name| !name.chars().any(char::is_control))
                    .unwrap_or_default(),
                line: None,
                dropped: true,
                problem: match reason {
                    SkipReason::Unreadable => unreadable.clone(),
                    SkipReason::Limit => limit.clone(),
                },
            }
        }));
    Ok(parsed)
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

#[cfg(test)]
mod source_import_tests {
    use super::*;
    use std::fs;

    #[test]
    #[cfg(unix)]
    fn xshell_source_reads_only_regular_sessions_under_the_selected_folder() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Sessions");
        let external = temp.path().join("Unselected");
        fs::create_dir_all(root.join("Work/Production")).unwrap();
        fs::create_dir(&external).unwrap();
        let session = "[CONNECTION]\nProtocol=SSH\nHost=host.example.test\n";
        fs::write(root.join("Work/Production/Build.XSH"), session).unwrap();
        fs::write(root.join("Not a session.txt"), session).unwrap();
        fs::write(external.join("Outside.xsh"), session).unwrap();
        symlink(external.join("Outside.xsh"), root.join("Linked.xsh")).unwrap();
        symlink(&external, root.join("Linked folder")).unwrap();

        let source =
            serde_json::from_value(serde_json::json!({ "kind": "xshell", "path": root })).unwrap();
        let parsed = read_import_source(source).unwrap();
        assert_eq!(parsed.hosts.len(), 1);
        assert_eq!(parsed.hosts[0].name, "Build");
        assert_eq!(parsed.hosts[0].group_path, ["Work", "Production"]);
        assert!(parsed
            .issues
            .iter()
            .any(|issue| issue.entry == "Linked.xsh" && issue.dropped));
        assert!(!format!("{parsed:?}").contains("Unselected"));
    }

    #[test]
    fn securecrt_source_reads_ini_sessions_and_ignores_reserved_files() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("Work")).unwrap();
        let session = "S:\"Protocol Name\"=SSH2\nS:\"Hostname\"=host.example.test\n";
        fs::write(root.path().join("Work/Build.INI"), session).unwrap();
        fs::write(root.path().join("Other.xsh"), session).unwrap();
        fs::write(root.path().join("Work/__FolderData__.ini"), session).unwrap();
        for file in ["DEFAULT.ini", "Oversized.ini"] {
            fs::File::create(root.path().join(file))
                .unwrap()
                .set_len(1024 * 1024)
                .unwrap();
        }

        let source =
            serde_json::from_value(serde_json::json!({ "kind": "securecrt", "path": root.path() }))
                .unwrap();
        let parsed = read_import_source(source).unwrap();
        assert_eq!(parsed.hosts.len(), 1);
        assert_eq!(parsed.hosts[0].name, "Build");
        assert_eq!(parsed.hosts[0].group_path, ["Work"]);
        let skipped: Vec<_> = parsed.issues.iter().filter(|issue| issue.dropped).collect();
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].entry, "Oversized.ini");
        assert_eq!(skipped[0].problem, ImportProblem::SecurecrtFolderLimit);
        assert_eq!(
            serde_json::to_value(&skipped[0].problem).unwrap(),
            serde_json::json!({ "kind": "securecrtFolderLimit" }),
        );
    }

    #[test]
    fn xshell_source_reports_oversized_files_without_losing_other_sessions() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("Build.xsh"),
            "[CONNECTION]\nProtocol=SSH\nHost=host.example.test\n",
        )
        .unwrap();
        let oversized = fs::File::create(root.path().join("Oversized.xsh")).unwrap();
        oversized.set_len(1024 * 1024).unwrap();

        let parsed = read_import_source(HostImportSource::Xshell {
            path: root.path().to_owned(),
        })
        .unwrap();
        assert_eq!(parsed.hosts[0].name, "Build");
        assert_eq!(parsed.hosts.len(), 1);
        assert!(parsed
            .issues
            .iter()
            .any(|issue| issue.entry == "Oversized.xsh"
                && issue.problem == ImportProblem::XshellFolderLimit
                && issue.dropped));
    }
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
