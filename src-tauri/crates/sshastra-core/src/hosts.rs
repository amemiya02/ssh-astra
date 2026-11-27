//! Hosts, the Groups that organise them, and the HostStore that keeps both: a
//! versioned JSON file in the app's config directory, replaced atomically on
//! every change. Credentials are never stored here.

use std::fmt;
use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::forward::{ForwardDraft, ForwardId, PortForward};
use crate::fs_util::write_atomically;
use crate::ssh_config::{ImportIssue, ParsedConfig};
use crate::terminal::{TerminalBackspace, TerminalCharset};

mod transfer;
pub use transfer::{ImportSummary, EXPORT_FORMAT};

/// The file format version this build writes, to the store and to export
/// files. Bump it together with a migration step in [`migrate`], which reads
/// both.
const CURRENT_VERSION: u32 = 11;

/// Identifies a Host across restarts and across the IPC boundary.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct HostId(String);

impl HostId {
    pub(crate) fn generate() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }
}

impl From<String> for HostId {
    fn from(raw: String) -> Self {
        Self(raw)
    }
}

impl fmt::Display for HostId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Identifies a Group across restarts and across the IPC boundary.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct GroupId(String);

impl GroupId {
    fn generate() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }
}

impl From<String> for GroupId {
    fn from(raw: String) -> Self {
        Self(raw)
    }
}

impl fmt::Display for GroupId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// A user-defined folder in the Host list. `parent_id: None` is the top level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: GroupId,
    pub name: String,
    pub parent_id: Option<GroupId>,
}

/// How a Host authenticates. Secrets are asked for (or read from the system
/// keychain) at connect time, never stored in the Host.
///
/// A connect tries ssh-agent first, then the selected key files, password,
/// and keyboard-interactive as the server allows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HostAuth {
    /// Try the default keys in the user's `.ssh` directory.
    Auto,
    /// No key file: agent, password, keyboard-interactive.
    Password,
    /// A private key file. A leading `~/` means the user's home directory.
    /// A passphrase is asked for when needed.
    Key { identity_file: PathBuf },
}

/// A saved, named set of connection settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: HostId,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub user: String,
    pub auth: HostAuth,
    /// With a selected identity, offer only its matching key from ssh-agent.
    #[serde(default)]
    pub identities_only: bool,
    /// Allow shells on this Host to forward the local SSH agent.
    #[serde(default)]
    pub forward_agent: bool,
    /// Seconds between keepalives; `None` follows the global setting, `Some(0)` turns them off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keepalive_seconds: Option<u32>,
    /// Command typed into every new Terminal shell once it is ready.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_login_command: Option<String>,
    /// Character set for Terminal input and output; absent uses UTF-8.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_charset: Option<TerminalCharset>,
    /// Byte sent by the Terminal's Backspace key; absent uses DEL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_backspace: Option<TerminalBackspace>,
    /// The Jump host this Host is reached through, itself possibly behind
    /// another one. Absent in files written before Jump hosts existed.
    #[serde(default)]
    pub jump_host: Option<HostId>,
    /// The Terminal colour scheme for this Host (e.g. to mark production),
    /// overriding the global one. Opaque to the core: the UI owns the names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_scheme: Option<String>,
    /// Where a File panel on this Host opens the first time (a remote path,
    /// `~/x` allowed); `None` is the home directory. Added in version 5.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_directory: Option<String>,
    /// The Group the Host sits in; `None` is the top level. Changed only by
    /// moving the Host, never by the Host form.
    #[serde(default)]
    pub group_id: Option<GroupId>,
    /// Port forward rules, in the order the user added them. Changed only
    /// through [`HostStore::save_forward`] / [`HostStore::delete_forward`],
    /// never by the Host form.
    #[serde(default)]
    pub forwards: Vec<PortForward>,
}

/// A Host's editable fields, as entered in the Host form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDraft {
    pub name: String,
    pub address: String,
    pub port: u16,
    pub user: String,
    pub auth: HostAuth,
    /// With a selected identity, offer only its matching key from ssh-agent.
    #[serde(default)]
    pub identities_only: bool,
    /// Allow shells on this Host to forward the local SSH agent.
    #[serde(default)]
    pub forward_agent: bool,
    /// Seconds between keepalives; `None` follows the global setting, `Some(0)` turns them off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keepalive_seconds: Option<u32>,
    /// Command typed into every new Terminal shell once it is ready.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_login_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_charset: Option<TerminalCharset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_backspace: Option<TerminalBackspace>,
    #[serde(default)]
    pub jump_host: Option<HostId>,
    /// The Terminal colour scheme for this Host (e.g. to mark production),
    /// overriding the global one. Opaque to the core: the UI owns the names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_scheme: Option<String>,
    /// Where a File panel opens first; blank is the home directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_directory: Option<String>,
}

impl HostDraft {
    pub(crate) fn into_host(self, id: HostId) -> Result<Host, HostStoreError> {
        let required = [
            ("name", &self.name),
            ("address", &self.address),
            ("user", &self.user),
        ];
        if let Some((field, _)) = required.iter().find(|(_, v)| v.trim().is_empty()) {
            return Err(HostStoreError::Invalid(field));
        }
        if self.port == 0 {
            return Err(HostStoreError::Invalid("port"));
        }
        let auth = match self.auth {
            HostAuth::Key { identity_file } => {
                let trimmed = identity_file.to_string_lossy().trim().to_owned();
                if trimmed.is_empty() {
                    return Err(HostStoreError::Invalid("identityFile"));
                }
                HostAuth::Key {
                    identity_file: PathBuf::from(trimmed),
                }
            }
            other => other,
        };
        Ok(Host {
            id,
            name: self.name.trim().to_owned(),
            address: self.address.trim().to_owned(),
            port: self.port,
            user: self.user.trim().to_owned(),
            auth,
            identities_only: self.identities_only,
            forward_agent: self.forward_agent,
            keepalive_seconds: self.keepalive_seconds,
            post_login_command: self.post_login_command.filter(|s| !s.trim().is_empty()),
            terminal_charset: self.terminal_charset,
            terminal_backspace: self.terminal_backspace,
            jump_host: self.jump_host,
            terminal_scheme: self
                .terminal_scheme
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty()),
            default_directory: self
                .default_directory
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty()),
            group_id: None,
            forwards: Vec::new(),
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum HostStoreError {
    #[error("could not access the host list at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("the host list file is damaged: {0}")]
    Corrupt(String),
    #[error("the host list was written by a newer sshastra (format version {0})")]
    UnsupportedVersion(u32),
    #[error("{0} is required")]
    Invalid(&'static str),
    #[error("no such host: {0}")]
    NotFound(HostId),
    #[error("no such group: {0}")]
    GroupNotFound(GroupId),
    #[error("no such Port forward: {0}")]
    ForwardNotFound(ForwardId),
    #[error("a group cannot move into itself or a group inside it")]
    InvalidMove,
    /// Following the Jump hosts leads back to where it started; the names
    /// along the loop, first and last the same.
    #[error("the jump hosts form a loop: {}", .0.join(" → "))]
    JumpHostCycle(Vec<String>),
    #[error("this host is the jump host of {by}")]
    InUseAsJumpHost { by: String },
}

impl HostStoreError {
    fn log_file_error(&self, operation: &str) {
        match self {
            Self::Io { source, .. } => {
                log::warn!("Host file {operation} failed: {:?}", source.kind())
            }
            Self::Corrupt(_) => log::warn!("Host file {operation} failed: corrupt"),
            Self::UnsupportedVersion(version) => {
                log::warn!("Host file {operation} failed: unsupported version {version}");
            }
            _ => {}
        }
    }
}

#[derive(Serialize)]
struct FileRef<'a> {
    /// [`EXPORT_FORMAT`] in export files; absent in the store's own file.
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<&'static str>,
    version: u32,
    groups: &'a [Group],
    hosts: &'a [Host],
}

#[derive(Deserialize)]
struct FileVersion {
    version: u32,
}

#[derive(Deserialize)]
struct FileV1 {
    hosts: Vec<Host>,
}

/// Versions 2, 4 and 5 (3 added `Host::forwards`, 4 `PortForward::auto_start`,
/// 5 `Host::default_directory`).
#[derive(Deserialize)]
struct FileV2 {
    groups: Vec<Group>,
    hosts: Vec<Host>,
}

/// A version 3 file: its Port forward rules have no `autoStart`.
#[derive(Deserialize)]
struct FileV3 {
    groups: Vec<Group>,
    hosts: Vec<serde_json::Value>,
}

/// Everything the HostStore keeps. Siblings are ordered by their position in
/// these lists.
#[derive(Clone, Default)]
struct Library {
    groups: Vec<Group>,
    hosts: Vec<Host>,
}

impl Library {
    fn check_group(&self, group: Option<&GroupId>) -> Result<(), HostStoreError> {
        match group {
            Some(id) if !self.groups.iter().any(|g| &g.id == id) => {
                Err(HostStoreError::GroupNotFound(id.clone()))
            }
            _ => Ok(()),
        }
    }

    fn host_mut(&mut self, id: &HostId) -> Result<&mut Host, HostStoreError> {
        self.hosts
            .iter_mut()
            .find(|h| &h.id == id)
            .ok_or_else(|| HostStoreError::NotFound(id.clone()))
    }

    fn group_index(&self, id: &GroupId) -> Result<usize, HostStoreError> {
        self.groups
            .iter()
            .position(|g| &g.id == id)
            .ok_or_else(|| HostStoreError::GroupNotFound(id.clone()))
    }

    /// `id`, its parent, its parent's parent, ... up to the top level.
    fn ancestors_and_self<'a>(&'a self, id: &'a GroupId) -> impl Iterator<Item = &'a GroupId> {
        // Bounded by the Group count, so a damaged file with a parent cycle
        // cannot loop forever.
        std::iter::successors(Some(id), |current| {
            self.groups
                .iter()
                .find(|g| &g.id == *current)
                .and_then(|g| g.parent_id.as_ref())
        })
        .take(self.groups.len() + 1)
    }
}

/// Inserts `item` as the `index`-th of its siblings in `items` (those for
/// which `same_parent(sibling, item)` holds), or right after the last one.
fn insert_among_siblings<T>(
    items: &mut Vec<T>,
    item: T,
    index: usize,
    same_parent: impl Fn(&T, &T) -> bool,
) {
    let mut siblings = items
        .iter()
        .enumerate()
        .filter(|(_, other)| same_parent(other, &item))
        .map(|(i, _)| i);
    let at = match siblings.nth(index) {
        Some(at) => at,
        None => items
            .iter()
            .rposition(|other| same_parent(other, &item))
            .map_or(items.len(), |last| last + 1),
    };
    items.insert(at, item);
}

/// The whole Host list: every Group and Host, siblings in display order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTree {
    pub groups: Vec<Group>,
    pub hosts: Vec<Host>,
}

/// What [`HostStore::import_ssh_config`] did, by Host name.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: Vec<String>,
    /// Already saved under that name: left as they are.
    pub skipped: Vec<String>,
    /// What could not be imported (or only in part), and why.
    pub issues: Vec<ImportIssue>,
}

/// Saved Hosts and Groups, in the order the user arranged them.
pub struct HostStore {
    path: PathBuf,
    library: Library,
}

impl HostStore {
    /// Loads the store at `path`, or starts empty if the file does not exist.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, HostStoreError> {
        let path = path.into();
        let library = match fs::read_to_string(&path) {
            Ok(text) => migrate(&text),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Library::default()),
            Err(source) => Err(HostStoreError::Io {
                path: path.clone(),
                source,
            }),
        }
        .inspect_err(|error| error.log_file_error("read"))?;
        Ok(Self { path, library })
    }

    pub fn list(&self) -> &[Host] {
        &self.library.hosts
    }

    pub fn groups(&self) -> &[Group] {
        &self.library.groups
    }

    pub fn tree(&self) -> HostTree {
        HostTree {
            groups: self.library.groups.clone(),
            hosts: self.library.hosts.clone(),
        }
    }

    pub fn get(&self, id: &HostId) -> Option<&Host> {
        self.library.hosts.iter().find(|h| &h.id == id)
    }

    /// The hops to reach Host `id`: its outermost Jump host first, the Host
    /// itself last (just `[host]` without a Jump host).
    pub fn jump_chain(&self, id: &HostId) -> Result<Vec<Host>, HostStoreError> {
        chain(&self.library.hosts, id)
    }

    /// The hops for an unsaved draft. An edited Host keeps its id so the same
    /// loop check applies if one of its proposed Jump hosts leads back to it.
    pub fn draft_jump_chain(
        &self,
        id: Option<HostId>,
        draft: HostDraft,
    ) -> Result<Vec<Host>, HostStoreError> {
        let host = draft.into_host(id.unwrap_or_else(HostId::generate))?;
        chain_from(&self.library.hosts, host)
    }

    /// Adds a Host (`id: None`) or replaces the one with `id`, then saves.
    pub fn upsert(&mut self, id: Option<HostId>, draft: HostDraft) -> Result<Host, HostStoreError> {
        let mut library = self.library.clone();
        let host = match id {
            None => {
                let host = draft.into_host(HostId::generate())?;
                library.hosts.push(host.clone());
                host
            }
            Some(id) => {
                let slot = library
                    .hosts
                    .iter_mut()
                    .find(|h| h.id == id)
                    .ok_or_else(|| HostStoreError::NotFound(id.clone()))?;
                let group_id = slot.group_id.clone();
                let forwards = std::mem::take(&mut slot.forwards);
                *slot = Host {
                    group_id,
                    forwards,
                    ..draft.into_host(id)?
                };
                slot.clone()
            }
        };
        chain(&library.hosts, &host.id)?;
        self.save(library)?;
        Ok(host)
    }

    pub fn delete(&mut self, id: &HostId) -> Result<(), HostStoreError> {
        if let Some(user) = self
            .library
            .hosts
            .iter()
            .find(|h| h.jump_host.as_ref() == Some(id))
        {
            return Err(HostStoreError::InUseAsJumpHost {
                by: user.name.clone(),
            });
        }
        let mut library = self.library.clone();
        let before = library.hosts.len();
        library.hosts.retain(|h| &h.id != id);
        if library.hosts.len() == before {
            return Err(HostStoreError::NotFound(id.clone()));
        }
        self.save(library)
    }

    /// Adds a Port forward rule to Host `host` (`id: None`, at the end) or
    /// replaces its rule `id`, then saves.
    pub fn save_forward(
        &mut self,
        host: &HostId,
        id: Option<ForwardId>,
        draft: ForwardDraft,
    ) -> Result<PortForward, HostStoreError> {
        let mut library = self.library.clone();
        let forwards = &mut library.host_mut(host)?.forwards;
        let forward = match id {
            None => {
                let forward = draft
                    .into_forward(ForwardId::generate())
                    .map_err(HostStoreError::Invalid)?;
                forwards.push(forward.clone());
                forward
            }
            Some(id) => {
                let slot = forwards
                    .iter_mut()
                    .find(|f| f.id == id)
                    .ok_or_else(|| HostStoreError::ForwardNotFound(id.clone()))?;
                *slot = draft.into_forward(id).map_err(HostStoreError::Invalid)?;
                slot.clone()
            }
        };
        self.save(library)?;
        Ok(forward)
    }

    /// Removes Host `host`'s Port forward rule `id`, then saves.
    pub fn delete_forward(&mut self, host: &HostId, id: &ForwardId) -> Result<(), HostStoreError> {
        let mut library = self.library.clone();
        let forwards = &mut library.host_mut(host)?.forwards;
        let before = forwards.len();
        forwards.retain(|f| &f.id != id);
        if forwards.len() == before {
            return Err(HostStoreError::ForwardNotFound(id.clone()));
        }
        self.save(library)
    }

    /// Adds the Hosts of a parsed `~/.ssh/config` at the top level, in one
    /// save. A Host whose name is already taken is skipped, and a Jump host
    /// named after a saved Host is that Host.
    pub fn import_ssh_config(
        &mut self,
        parsed: ParsedConfig,
    ) -> Result<ImportReport, HostStoreError> {
        let mut library = self.library.clone();
        let mut report = ImportReport {
            issues: parsed.issues,
            ..ImportReport::default()
        };
        let mut ids: std::collections::HashMap<String, HostId> = library
            .hosts
            .iter()
            .map(|h| (h.name.clone(), h.id.clone()))
            .collect();
        let mut added = Vec::new();
        for entry in parsed.hosts {
            if ids.contains_key(&entry.name) {
                report.skipped.push(entry.name);
                continue;
            }
            let id = HostId::generate();
            ids.insert(entry.name.clone(), id.clone());
            added.push((id, entry));
        }
        for (id, entry) in added {
            let jump_host = entry
                .jump_host
                .as_ref()
                .and_then(|name| ids.get(name).cloned());
            let auth = match entry.identity_file {
                Some(identity_file) => HostAuth::Key { identity_file },
                None => HostAuth::Auto,
            };
            let mut host = HostDraft {
                name: entry.name.clone(),
                address: entry.address,
                port: entry.port,
                user: entry.user,
                auth,
                identities_only: entry.identities_only,
                forward_agent: entry.forward_agent,
                keepalive_seconds: entry.keepalive_seconds,
                post_login_command: None,
                terminal_charset: None,
                terminal_backspace: None,
                jump_host,
                terminal_scheme: None,
                default_directory: None,
            }
            .into_host(id)?;
            for draft in entry.forwards {
                host.forwards.push(
                    draft
                        .into_forward(ForwardId::generate())
                        .map_err(HostStoreError::Invalid)?,
                );
            }
            library.hosts.push(host);
            report.imported.push(entry.name);
        }
        for name in &report.imported {
            chain(&library.hosts, &ids[name])?;
        }
        self.save(library)?;
        Ok(report)
    }

    /// Adds a Group at the end of `parent` (`None`: the top level).
    pub fn create_group(
        &mut self,
        name: &str,
        parent: Option<GroupId>,
    ) -> Result<Group, HostStoreError> {
        let mut library = self.library.clone();
        library.check_group(parent.as_ref())?;
        let group = Group {
            id: GroupId::generate(),
            name: required_name(name)?,
            parent_id: parent,
        };
        library.groups.push(group.clone());
        self.save(library)?;
        Ok(group)
    }

    /// Saves a copy of a Host under a new id and `name`, right after the
    /// original in the same Group.
    pub fn duplicate_host(&mut self, id: &HostId, name: &str) -> Result<Host, HostStoreError> {
        let mut library = self.library.clone();
        let at = library
            .hosts
            .iter()
            .position(|h| &h.id == id)
            .ok_or_else(|| HostStoreError::NotFound(id.clone()))?;
        // A clone, so every setting (including ones added later) is copied.
        let mut copy = Host {
            id: HostId::generate(),
            name: required_name(name)?,
            ..library.hosts[at].clone()
        };
        for forward in &mut copy.forwards {
            forward.id = ForwardId::generate();
        }
        library.hosts.insert(at + 1, copy.clone());
        self.save(library)?;
        Ok(copy)
    }

    pub fn rename_group(&mut self, id: &GroupId, name: &str) -> Result<Group, HostStoreError> {
        let mut library = self.library.clone();
        let at = library.group_index(id)?;
        library.groups[at].name = required_name(name)?;
        let group = library.groups[at].clone();
        self.save(library)?;
        Ok(group)
    }

    /// Deletes a Group. Its Hosts and Groups are kept: they move up into the
    /// deleted Group's parent.
    pub fn delete_group(&mut self, id: &GroupId) -> Result<(), HostStoreError> {
        let mut library = self.library.clone();
        let at = library.group_index(id)?;
        let parent = library.groups.remove(at).parent_id;
        for group in library
            .groups
            .iter_mut()
            .filter(|g| g.parent_id.as_ref() == Some(id))
        {
            group.parent_id = parent.clone();
        }
        for host in library
            .hosts
            .iter_mut()
            .filter(|h| h.group_id.as_ref() == Some(id))
        {
            host.group_id = parent.clone();
        }
        self.save(library)
    }

    /// Moves a Host into `group` (`None`: the top level) as its `index`-th
    /// Host; an index past the end places it last.
    pub fn move_host(
        &mut self,
        id: &HostId,
        group: Option<GroupId>,
        index: usize,
    ) -> Result<(), HostStoreError> {
        let mut library = self.library.clone();
        library.check_group(group.as_ref())?;
        let from = library
            .hosts
            .iter()
            .position(|h| &h.id == id)
            .ok_or_else(|| HostStoreError::NotFound(id.clone()))?;
        let mut host = library.hosts.remove(from);
        host.group_id = group;
        insert_among_siblings(&mut library.hosts, host, index, |a, b| {
            a.group_id == b.group_id
        });
        self.save(library)
    }

    /// Moves a Group, with everything in it, under `parent` (`None`: the top
    /// level) as its `index`-th Group; an index past the end places it last.
    pub fn move_group(
        &mut self,
        id: &GroupId,
        parent: Option<GroupId>,
        index: usize,
    ) -> Result<(), HostStoreError> {
        let mut library = self.library.clone();
        library.check_group(parent.as_ref())?;
        let from = library.group_index(id)?;
        if let Some(target) = &parent {
            if library.ancestors_and_self(target).any(|g| g == id) {
                return Err(HostStoreError::InvalidMove);
            }
        }
        let mut group = library.groups.remove(from);
        group.parent_id = parent;
        insert_among_siblings(&mut library.groups, group, index, |a, b| {
            a.parent_id == b.parent_id
        });
        self.save(library)
    }

    /// Writes `library` and only then adopts it, so memory never runs ahead
    /// of the file.
    fn save(&mut self, library: Library) -> Result<(), HostStoreError> {
        let json = serde_json::to_vec_pretty(&FileRef {
            format: None,
            version: CURRENT_VERSION,
            groups: &library.groups,
            hosts: &library.hosts,
        })
        .map_err(|e| HostStoreError::Corrupt(e.to_string()))
        .inspect_err(|error| error.log_file_error("serialize"))?;
        write_atomically(&self.path, &json)
            .map_err(|source| HostStoreError::Io {
                path: self.path.clone(),
                source,
            })
            .inspect_err(|error| error.log_file_error("write"))?;
        self.library = library;
        Ok(())
    }
}

fn required_name(name: &str) -> Result<String, HostStoreError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(HostStoreError::Invalid("name"));
    }
    Ok(name.to_owned())
}

/// Follows `id`'s Jump hosts outwards; see [`HostStore::jump_chain`].
fn chain(hosts: &[Host], id: &HostId) -> Result<Vec<Host>, HostStoreError> {
    chain_from(hosts, find_host(hosts, id)?.clone())
}

fn find_host<'a>(hosts: &'a [Host], id: &HostId) -> Result<&'a Host, HostStoreError> {
    hosts
        .iter()
        .find(|h| &h.id == id)
        .ok_or_else(|| HostStoreError::NotFound(id.clone()))
}

fn chain_from(hosts: &[Host], host: Host) -> Result<Vec<Host>, HostStoreError> {
    let mut hops = vec![host];
    while let Some(next) = &hops[hops.len() - 1].jump_host {
        if let Some(start) = hops.iter().position(|h| &h.id == next) {
            let mut names: Vec<String> = hops[start..].iter().map(|h| h.name.clone()).collect();
            names.push(hops[start].name.clone());
            return Err(HostStoreError::JumpHostCycle(names));
        }
        hops.push(find_host(hosts, next)?.clone());
    }
    hops.reverse();
    Ok(hops)
}

/// Reads any supported version of the store file or an export file into the
/// current model.
fn migrate(text: &str) -> Result<Library, HostStoreError> {
    let corrupt = |e: serde_json::Error| HostStoreError::Corrupt(e.to_string());
    let FileVersion { version } = serde_json::from_str(text).map_err(corrupt)?;
    let mut library = match version {
        // v1 had no Groups: every Host sits at the top level.
        1 => Ok(Library {
            groups: Vec::new(),
            hosts: serde_json::from_str::<FileV1>(text).map_err(corrupt)?.hosts,
        }),
        // v3 added Port forwards on Hosts, each with `autoStart` (off) in v4.
        3 => {
            let FileV3 { groups, mut hosts } = serde_json::from_str(text).map_err(corrupt)?;
            for host in &mut hosts {
                let rules = host.get_mut("forwards").and_then(|f| f.as_array_mut());
                for rule in rules.into_iter().flatten() {
                    if let Some(rule) = rule.as_object_mut() {
                        rule.insert("autoStart".into(), false.into());
                    }
                }
            }
            let hosts = serde_json::from_value(hosts.into()).map_err(corrupt)?;
            Ok(Library { groups, hosts })
        }
        // v2 Hosts have no Port forwards, which `Host::forwards` defaults to.
        // v2-v4 have no default directory (`None`: home). v6 adds `Auto`
        // without changing how older authentication choices are read. v7
        // adds IdentitiesOnly, which defaults to off in older files. v8
        // adds ForwardAgent. v9 adds a keepalive interval; older Hosts omit
        // it and inherit the global one via Host's serde default. v10
        // adds a command sent after each shell opens. v11 adds the Terminal
        // character set and Backspace byte, defaulting to UTF-8 and DEL.
        2 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | CURRENT_VERSION => {
            let FileV2 { groups, hosts } = serde_json::from_str(text).map_err(corrupt)?;
            Ok(Library { groups, hosts })
        }
        other => Err(HostStoreError::UnsupportedVersion(other)),
    }?;
    if version < 8 {
        // An extra field in an older file did not authorize forwarding.
        for host in &mut library.hosts {
            host.forward_agent = false;
        }
    }
    if version < 10 {
        // An extra field in an older file was never configured to run.
        for host in &mut library.hosts {
            host.post_login_command = None;
        }
    }
    Ok(library)
}
