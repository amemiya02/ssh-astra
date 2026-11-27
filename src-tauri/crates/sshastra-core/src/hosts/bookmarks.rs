//! Directories saved on a Host and addressed by their canonical remote path.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::{HostId, HostStore, HostStoreError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bookmark {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl HostStore {
    /// Saves a directory as a Bookmark. Adding the same path keeps its name and position.
    pub fn add_bookmark(&mut self, host: &HostId, path: &str) -> Result<Bookmark, HostStoreError> {
        if !valid_path(path) {
            return Err(HostStoreError::InvalidBookmarkPath);
        }
        let mut library = self.library.clone();
        let bookmarks = &mut library.host_mut(host)?.bookmarks;
        if let Some(existing) = bookmarks.iter().find(|bookmark| bookmark.path == path) {
            return Ok(existing.clone());
        }
        let bookmark = Bookmark {
            path: path.to_owned(),
            name: None,
        };
        bookmarks.push(bookmark.clone());
        self.save(library)?;
        Ok(bookmark)
    }

    /// Updates a Bookmark's display name. An empty name makes the menu show only its path.
    pub fn rename_bookmark(
        &mut self,
        host: &HostId,
        path: &str,
        name: &str,
    ) -> Result<Bookmark, HostStoreError> {
        let mut library = self.library.clone();
        let bookmark = library
            .host_mut(host)?
            .bookmarks
            .iter_mut()
            .find(|bookmark| bookmark.path == path)
            .ok_or(HostStoreError::BookmarkNotFound)?;
        let name = name.trim();
        bookmark.name = (!name.is_empty()).then(|| name.to_owned());
        let saved = bookmark.clone();
        self.save(library)?;
        Ok(saved)
    }

    /// Removes the Bookmark for a path if it exists on the Host.
    pub fn delete_bookmark(&mut self, host: &HostId, path: &str) -> Result<(), HostStoreError> {
        let mut library = self.library.clone();
        let bookmarks = &mut library.host_mut(host)?.bookmarks;
        let before = bookmarks.len();
        bookmarks.retain(|bookmark| bookmark.path != path);
        if bookmarks.len() == before {
            return Ok(());
        }
        self.save(library)
    }
}

fn valid_path(path: &str) -> bool {
    !path.is_empty() && !path.contains('\0')
}

pub(super) fn retain_valid(bookmarks: &mut Vec<Bookmark>) {
    let mut seen = HashSet::new();
    bookmarks.retain(|bookmark| valid_path(&bookmark.path) && seen.insert(bookmark.path.clone()));
}
