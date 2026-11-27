use std::collections::HashSet;

use serde::Deserialize;

use super::{normalize_tags, GroupId, HostId, HostStore, HostStoreError, HostTree, MAX_HOST_TAGS};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostTagChange {
    Add,
    Remove,
}

impl HostStore {
    pub(super) fn validate_selection<'a>(
        &self,
        ids: &'a [HostId],
    ) -> Result<HashSet<&'a HostId>, HostStoreError> {
        if ids.is_empty() {
            return Err(HostStoreError::Invalid("hosts"));
        }
        let saved: HashSet<_> = self.list().iter().map(|host| &host.id).collect();
        for id in ids {
            if !saved.contains(id) {
                return Err(HostStoreError::NotFound(id.clone()));
            }
        }
        Ok(ids.iter().collect())
    }

    /// Appends the selected Hosts that are outside the target Group, in saved order.
    pub fn move_hosts(
        &mut self,
        ids: &[HostId],
        group: Option<GroupId>,
    ) -> Result<HostTree, HostStoreError> {
        let selected = self.validate_selection(ids)?;
        self.library.check_group(group.as_ref())?;
        let mut library = self.library.clone();
        let moved: Vec<_> = library
            .hosts
            .extract_if(.., |host| {
                selected.contains(&host.id) && host.group_id != group
            })
            .map(|mut host| {
                host.group_id = group.clone();
                host
            })
            .collect();
        let index = library
            .hosts
            .iter()
            .rposition(|host| host.group_id == group)
            .map_or(library.hosts.len(), |last| last + 1);
        library.hosts.splice(index..index, moved);
        self.save(library)?;
        Ok(self.tree())
    }

    /// Adds or removes the same Tag on every selected Host.
    pub fn edit_host_tags(
        &mut self,
        ids: &[HostId],
        change: HostTagChange,
        tag: &str,
    ) -> Result<HostTree, HostStoreError> {
        let selected = self.validate_selection(ids)?;
        let tag = normalize_tags(&[tag.to_owned()])
            .pop()
            .ok_or(HostStoreError::Invalid("tag"))?;
        let key = tag.to_lowercase();
        let mut library = self.library.clone();
        for host in library
            .hosts
            .iter_mut()
            .filter(|host| selected.contains(&host.id))
        {
            match change {
                HostTagChange::Add => {
                    if host.tags.iter().any(|tag| tag.to_lowercase() == key) {
                        continue;
                    }
                    if host.tags.len() >= MAX_HOST_TAGS {
                        return Err(HostStoreError::TagLimit {
                            host: host.name.clone(),
                        });
                    }
                    host.tags.push(tag.clone());
                }
                HostTagChange::Remove => host.tags.retain(|tag| tag.to_lowercase() != key),
            }
        }
        self.save(library)?;
        Ok(self.tree())
    }

    /// Deletes the selection together, provided no remaining Host depends on it as a Jump host.
    pub fn delete_hosts(&mut self, ids: &[HostId]) -> Result<HostTree, HostStoreError> {
        self.delete_selection(ids)?;
        Ok(self.tree())
    }

    pub(super) fn delete_selection(&mut self, ids: &[HostId]) -> Result<(), HostStoreError> {
        let selected = self.validate_selection(ids)?;
        if let Some(user) = self.list().iter().find(|host| {
            !selected.contains(&host.id)
                && host
                    .jump_host
                    .as_ref()
                    .is_some_and(|id| selected.contains(id))
        }) {
            return Err(HostStoreError::InUseAsJumpHost {
                by: user.name.clone(),
            });
        }
        let mut library = self.library.clone();
        library.hosts.retain(|host| !selected.contains(&host.id));
        self.save(library)
    }
}
