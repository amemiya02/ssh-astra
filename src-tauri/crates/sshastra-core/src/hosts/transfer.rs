//! Export files: the whole Host list (Groups, Hosts and their Port forwards)
//! in the HostStore's own versioned format, marked with [`EXPORT_FORMAT`], so
//! importing an older one runs the same migrations as opening an old store.
//! Credentials are never part of it: they live only in the CredentialVault.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{chain, migrate, FileRef, Group, GroupId, Host, HostId, HostStore, HostStoreError};
use crate::forward::ForwardId;
use crate::fs_util::write_atomically;

/// The `format` marker of an export file. Files without one (e.g. a copied
/// `hosts.json`) are accepted too.
pub const EXPORT_FORMAT: &str = "sshastra-hosts";

/// What an import added and left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub hosts_added: usize,
    pub groups_added: usize,
    /// Names of the file's Hosts that were not added because a Host with the
    /// same name already exists. Imported Hosts that used one as their Jump
    /// host now use the existing Host.
    pub skipped_hosts: Vec<String>,
}

#[derive(Deserialize)]
struct FileFormat {
    #[serde(default)]
    format: Option<String>,
}

impl HostStore {
    /// The whole Host list as an export file (JSON), with no credentials.
    pub fn export(&self) -> String {
        serde_json::to_string_pretty(&FileRef {
            format: Some(EXPORT_FORMAT),
            version: super::CURRENT_VERSION,
            groups: &self.library.groups,
            hosts: &self.library.hosts,
        })
        .expect("the Host list always serializes")
    }

    /// Writes [`HostStore::export`] to `path`, replacing it atomically.
    pub fn export_to(&self, path: &Path) -> Result<(), HostStoreError> {
        write_atomically(path, self.export().as_bytes())
            .map_err(|source| HostStoreError::Io {
                path: path.to_owned(),
                source,
            })
            .inspect_err(|error| error.log_file_error("export"))
    }

    /// [`HostStore::import`] of the file at `path`.
    pub fn import_from(&mut self, path: &Path) -> Result<ImportSummary, HostStoreError> {
        let text = fs::read_to_string(path).map_err(|source| HostStoreError::Io {
            path: path.to_owned(),
            source,
        });
        text.and_then(|text| self.import(&text))
            .inspect_err(|error| error.log_file_error("import"))
    }

    /// Adds the Groups and Hosts of an export file (any supported version),
    /// after the existing ones, then saves. Everything gets a new id, with
    /// Group, Jump host and Port forward references following. A Group that
    /// already exists by name under the same parent is reused; a Host whose
    /// name is already taken is skipped. Nothing changes if the file is
    /// unreadable or its Jump hosts form a loop.
    pub fn import(&mut self, text: &str) -> Result<ImportSummary, HostStoreError> {
        let corrupt = |e: serde_json::Error| HostStoreError::Corrupt(e.to_string());
        let FileFormat { format } = serde_json::from_str(text).map_err(corrupt)?;
        if let Some(other) = format.filter(|f| f != EXPORT_FORMAT) {
            return Err(HostStoreError::Corrupt(format!(
                "not an sshastra Host list (format {other:?})"
            )));
        }
        let incoming = migrate(text)?;

        let mut library = self.library.clone();
        let groups = merge_groups(&mut library.groups, &incoming.groups)?;
        let groups_added = library.groups.len() - self.library.groups.len();

        let existing: HashMap<String, HostId> = library
            .hosts
            .iter()
            .map(|h| (h.name.clone(), h.id.clone()))
            .collect();
        let mut hosts: HashMap<HostId, HostId> = HashMap::new();
        let mut added: Vec<Host> = Vec::new();
        let mut skipped_hosts = Vec::new();
        for host in &incoming.hosts {
            if let Some(id) = existing.get(&host.name) {
                hosts.insert(host.id.clone(), id.clone());
                skipped_hosts.push(host.name.clone());
                continue;
            }
            let mut copy = host.clone();
            copy.id = HostId::generate();
            copy.group_id = host.group_id.as_ref().and_then(|g| groups.get(g).cloned());
            for forward in &mut copy.forwards {
                forward.id = ForwardId::generate();
            }
            hosts.insert(host.id.clone(), copy.id.clone());
            added.push(copy);
        }
        // A Jump host missing from the file is dropped: connect directly.
        for host in &mut added {
            host.jump_host = host.jump_host.as_ref().and_then(|j| hosts.get(j).cloned());
        }
        let hosts_added = added.len();
        let ids: Vec<HostId> = added.iter().map(|h| h.id.clone()).collect();
        library.hosts.extend(added);
        for id in &ids {
            chain(&library.hosts, id)?;
        }

        self.save(library)?;
        Ok(ImportSummary {
            hosts_added,
            groups_added,
            skipped_hosts,
        })
    }
}

/// Adds `incoming` Groups to `groups`, in the file's order (their sibling
/// order); returns each incoming id's id in `groups`. A Group already in
/// `groups` with the same name and parent is reused rather than added. A
/// parent missing from the file means the top level.
fn merge_groups(
    groups: &mut Vec<Group>,
    incoming: &[Group],
) -> Result<HashMap<GroupId, GroupId>, HostStoreError> {
    let position: HashMap<&GroupId, usize> = incoming
        .iter()
        .enumerate()
        .map(|(i, g)| (&g.id, i))
        .collect();
    let existing = groups.len();
    let mut mapped: HashMap<GroupId, GroupId> = HashMap::new();
    let mut added: Vec<(usize, Group)> = Vec::new();

    for group in incoming {
        // `group` and its not-yet-mapped ancestors, innermost first.
        let mut pending = vec![group];
        while let Some(&parent) = pending[pending.len() - 1]
            .parent_id
            .as_ref()
            .filter(|p| !mapped.contains_key(*p))
            .and_then(|p| position.get(p))
        {
            if pending.len() > incoming.len() {
                return Err(HostStoreError::Corrupt("the groups form a loop".into()));
            }
            pending.push(&incoming[parent]);
        }
        for g in pending.into_iter().rev() {
            if mapped.contains_key(&g.id) {
                continue;
            }
            let parent_id = g.parent_id.as_ref().and_then(|p| mapped.get(p).cloned());
            let reused = groups[..existing]
                .iter()
                .find(|e| e.name == g.name && e.parent_id == parent_id)
                .map(|e| e.id.clone());
            let id = reused.unwrap_or_else(|| {
                let id = GroupId::generate();
                added.push((
                    position[&g.id],
                    Group {
                        id: id.clone(),
                        name: g.name.clone(),
                        parent_id,
                    },
                ));
                id
            });
            mapped.insert(g.id.clone(), id);
        }
    }

    added.sort_by_key(|(at, _)| *at);
    groups.extend(added.into_iter().map(|(_, g)| g));
    Ok(mapped)
}
