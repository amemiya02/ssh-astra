//! Saved Snippets in the app's versioned, atomically replaced JSON file.

use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fs_util::write_atomically;
use crate::hosts::HostId;

const CURRENT_VERSION: u32 = 1;
const EXPORT_FORMAT: &str = "sshastra-snippets";

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SnippetId(String);

impl SnippetId {
    fn generate() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }
}

impl fmt::Display for SnippetId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetDraft {
    pub name: String,
    pub command: String,
    pub group: Option<String>,
    /// Empty means this Snippet is visible for all Hosts and Local terminals.
    #[serde(default)]
    pub host_ids: Vec<HostId>,
    #[serde(default = "default_send_enter")]
    pub send_enter: bool,
}

fn default_send_enter() -> bool {
    true
}

impl SnippetDraft {
    fn validate(&self) -> Result<(), SnippetStoreError> {
        if self.name.trim().is_empty() {
            return Err(SnippetStoreError::Invalid("name"));
        }
        if self.command.trim().is_empty() {
            return Err(SnippetStoreError::Invalid("command"));
        }
        Ok(())
    }

    fn normalized(mut self) -> Result<Self, SnippetStoreError> {
        self.validate()?;
        self.name = self.name.trim().to_owned();
        self.group = self
            .group
            .map(|group| group.trim().to_owned())
            .filter(|group| !group.is_empty());
        let mut seen = HashSet::new();
        self.host_ids.retain(|id| seen.insert(id.clone()));
        Ok(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snippet {
    pub id: SnippetId,
    #[serde(flatten)]
    pub draft: SnippetDraft,
}

#[derive(Debug, Serialize)]
pub struct SnippetImportReport {
    pub added: Vec<Snippet>,
    pub skipped: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum SnippetStoreError {
    #[error("could not access Snippets at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("the Snippet file is damaged: {0}")]
    Corrupt(String),
    #[error("unsupported Snippet file format version {0}")]
    UnsupportedVersion(u32),
    #[error("{0} is required")]
    Invalid(&'static str),
    #[error("no such Snippet: {0}")]
    NotFound(SnippetId),
}

#[derive(Deserialize)]
struct FileVersion {
    format: Option<String>,
    version: u32,
}

#[derive(Deserialize)]
struct FileV1 {
    snippets: Vec<Snippet>,
}

#[derive(Serialize)]
struct FileRef<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<&'static str>,
    version: u32,
    snippets: &'a [Snippet],
}

pub struct SnippetStore {
    path: PathBuf,
    snippets: Vec<Snippet>,
}

impl SnippetStore {
    /// Open the file without changing it. A missing file starts an empty library.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, SnippetStoreError> {
        let path = path.into();
        let snippets = match fs::read(&path) {
            Ok(bytes) => migrate(&bytes)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(source) => return Err(SnippetStoreError::Io { path, source }),
        };
        Ok(Self { path, snippets })
    }

    pub fn list(&self) -> &[Snippet] {
        &self.snippets
    }

    pub fn upsert(
        &mut self,
        id: Option<SnippetId>,
        draft: SnippetDraft,
    ) -> Result<Snippet, SnippetStoreError> {
        let draft = draft.normalized()?;
        let mut snippets = self.snippets.clone();
        let snippet = match id {
            None => {
                let snippet = Snippet {
                    id: SnippetId::generate(),
                    draft,
                };
                snippets.push(snippet.clone());
                snippet
            }
            Some(id) => {
                let index = self.index(&id)?;
                let snippet = Snippet { id, draft };
                snippets[index] = snippet.clone();
                snippet
            }
        };
        self.save(snippets)?;
        Ok(snippet)
    }

    pub fn delete(&mut self, id: &SnippetId) -> Result<(), SnippetStoreError> {
        let index = self.index(id)?;
        let mut snippets = self.snippets.clone();
        snippets.remove(index);
        self.save(snippets)
    }

    /// Export the full Snippet library, including Snippets scoped to other Hosts.
    pub fn export_to(&self, path: &Path) -> Result<(), SnippetStoreError> {
        write_file(path, &self.snippets, Some(EXPORT_FORMAT))
    }

    /// Import a valid Snippet file, skipping names already taken in the library or file.
    pub fn import_from(&mut self, path: &Path) -> Result<SnippetImportReport, SnippetStoreError> {
        let bytes = fs::read(path).map_err(|source| SnippetStoreError::Io {
            path: path.to_owned(),
            source,
        })?;
        let incoming = parse_file(&bytes)?;
        let mut names: HashSet<_> = self
            .snippets
            .iter()
            .map(|snippet| snippet.draft.name.trim().to_owned())
            .collect();
        let mut added = Vec::new();
        let mut skipped = Vec::new();
        for (index, snippet) in incoming.into_iter().enumerate() {
            if snippet.id.0.is_empty() {
                return Err(SnippetStoreError::Corrupt(format!(
                    "Snippet {} is missing its ID",
                    index + 1
                )));
            }
            let draft = snippet.draft.normalized().map_err(|error| {
                SnippetStoreError::Corrupt(format!("Snippet {}: {error}", index + 1))
            })?;
            if names.insert(draft.name.clone()) {
                added.push(Snippet {
                    id: SnippetId::generate(),
                    draft,
                });
            } else {
                skipped.push(draft.name);
            }
        }
        if !added.is_empty() {
            let mut next = self.snippets.clone();
            next.extend(added.iter().cloned());
            self.save(next)?;
        }
        Ok(SnippetImportReport { added, skipped })
    }

    fn index(&self, id: &SnippetId) -> Result<usize, SnippetStoreError> {
        self.snippets
            .iter()
            .position(|snippet| &snippet.id == id)
            .ok_or_else(|| SnippetStoreError::NotFound(id.clone()))
    }

    fn save(&mut self, snippets: Vec<Snippet>) -> Result<(), SnippetStoreError> {
        write_file(&self.path, &snippets, None)?;
        self.snippets = snippets;
        Ok(())
    }
}

fn write_file(
    path: &Path,
    snippets: &[Snippet],
    format: Option<&'static str>,
) -> Result<(), SnippetStoreError> {
    let bytes = serde_json::to_vec_pretty(&FileRef {
        format,
        version: CURRENT_VERSION,
        snippets,
    })
    .map_err(|error| SnippetStoreError::Corrupt(error.to_string()))?;
    write_atomically(path, &bytes).map_err(|source| SnippetStoreError::Io {
        path: path.to_owned(),
        source,
    })
}

fn parse_file(bytes: &[u8]) -> Result<Vec<Snippet>, SnippetStoreError> {
    let corrupt = |error: serde_json::Error| SnippetStoreError::Corrupt(error.to_string());
    let FileVersion { format, version } = serde_json::from_slice(bytes).map_err(corrupt)?;
    if let Some(other) = format.filter(|format| format != EXPORT_FORMAT) {
        return Err(SnippetStoreError::Corrupt(format!(
            "not an sshastra Snippet library (format {other:?})"
        )));
    }
    match version {
        1 => Ok(serde_json::from_slice::<FileV1>(bytes)
            .map_err(corrupt)?
            .snippets),
        other => Err(SnippetStoreError::UnsupportedVersion(other)),
    }
}

fn migrate(bytes: &[u8]) -> Result<Vec<Snippet>, SnippetStoreError> {
    let snippets = parse_file(bytes)?;
    let mut ids = HashSet::new();
    for snippet in &snippets {
        if snippet.id.0.is_empty() || !ids.insert(&snippet.id) {
            return Err(SnippetStoreError::Corrupt(
                "missing or duplicate Snippet ID".into(),
            ));
        }
        snippet
            .draft
            .validate()
            .map_err(|error| SnippetStoreError::Corrupt(error.to_string()))?;
    }
    Ok(snippets)
}
