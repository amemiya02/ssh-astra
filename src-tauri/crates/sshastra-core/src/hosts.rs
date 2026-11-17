//! Hosts, the Groups that organise them, and the HostStore that keeps both: a
//! versioned JSON file in the app's config directory, replaced atomically on
//! every change. Credentials are never stored here.

use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// The file format version this build writes. Bump it together with a
/// migration step in [`migrate`].
const CURRENT_VERSION: u32 = 2;

/// Identifies a Host across restarts and across the IPC boundary.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct HostId(String);

impl HostId {
    fn generate() -> Self {
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HostAuth {
    Password,
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
    /// The Group the Host sits in; `None` is the top level. Changed only by
    /// moving the Host, never by the Host form.
    #[serde(default)]
    pub group_id: Option<GroupId>,
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
}

impl HostDraft {
    fn into_host(self, id: HostId) -> Result<Host, HostStoreError> {
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
        Ok(Host {
            id,
            name: self.name.trim().to_owned(),
            address: self.address.trim().to_owned(),
            port: self.port,
            user: self.user.trim().to_owned(),
            auth: self.auth,
            group_id: None,
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
    #[error("a group cannot move into itself or a group inside it")]
    InvalidMove,
}

#[derive(Serialize)]
struct FileRef<'a> {
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

#[derive(Deserialize)]
struct FileV2 {
    groups: Vec<Group>,
    hosts: Vec<Host>,
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
            Ok(text) => migrate(&text)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Library::default(),
            Err(source) => return Err(HostStoreError::Io { path, source }),
        };
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
                *slot = Host {
                    group_id,
                    ..draft.into_host(id)?
                };
                slot.clone()
            }
        };
        self.save(library)?;
        Ok(host)
    }

    pub fn delete(&mut self, id: &HostId) -> Result<(), HostStoreError> {
        let mut library = self.library.clone();
        let before = library.hosts.len();
        library.hosts.retain(|h| &h.id != id);
        if library.hosts.len() == before {
            return Err(HostStoreError::NotFound(id.clone()));
        }
        self.save(library)
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
        let copy = Host {
            id: HostId::generate(),
            name: required_name(name)?,
            ..library.hosts[at].clone()
        };
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
            version: CURRENT_VERSION,
            groups: &library.groups,
            hosts: &library.hosts,
        })
        .map_err(|e| HostStoreError::Corrupt(e.to_string()))?;
        write_atomically(&self.path, &json).map_err(|source| HostStoreError::Io {
            path: self.path.clone(),
            source,
        })?;
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

/// Reads any supported file version into the current model.
fn migrate(text: &str) -> Result<Library, HostStoreError> {
    let corrupt = |e: serde_json::Error| HostStoreError::Corrupt(e.to_string());
    let FileVersion { version } = serde_json::from_str(text).map_err(corrupt)?;
    match version {
        // v1 had no Groups: every Host sits at the top level.
        1 => Ok(Library {
            groups: Vec::new(),
            hosts: serde_json::from_str::<FileV1>(text).map_err(corrupt)?.hosts,
        }),
        2 => {
            let FileV2 { groups, hosts } = serde_json::from_str(text).map_err(corrupt)?;
            Ok(Library { groups, hosts })
        }
        other => Err(HostStoreError::UnsupportedVersion(other)),
    }
}

/// Writes a sibling temp file, flushes it to disk, then renames it over
/// `path`: readers see either the old file or the new one, never a mix.
fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));

    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        rename_replacing(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// `fs::rename`, retried briefly: on Windows a reader holding the target open
/// can make the replace fail with "access denied" for a moment.
fn rename_replacing(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempts = 0;
    loop {
        match fs::rename(from, to) {
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied && attempts < 20 => {
                attempts += 1;
                std::thread::sleep(Duration::from_millis(10));
            }
            other => return other,
        }
    }
}
