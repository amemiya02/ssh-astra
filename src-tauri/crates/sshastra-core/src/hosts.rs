//! Hosts and the HostStore that keeps them: a versioned JSON file in the app's
//! config directory, replaced atomically on every change. Credentials are
//! never stored here.

use std::fmt;
use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::fs_util::write_atomically;

/// The file format version this build writes. Bump it together with a
/// migration step in [`migrate`].
const CURRENT_VERSION: u32 = 1;

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
}

#[derive(Serialize)]
struct FileRef<'a> {
    version: u32,
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

/// Saved Hosts, in the order the user added them.
pub struct HostStore {
    path: PathBuf,
    hosts: Vec<Host>,
}

impl HostStore {
    /// Loads the store at `path`, or starts empty if the file does not exist.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, HostStoreError> {
        let path = path.into();
        let hosts = match fs::read_to_string(&path) {
            Ok(text) => migrate(&text)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(source) => return Err(HostStoreError::Io { path, source }),
        };
        Ok(Self { path, hosts })
    }

    pub fn list(&self) -> &[Host] {
        &self.hosts
    }

    pub fn get(&self, id: &HostId) -> Option<&Host> {
        self.hosts.iter().find(|h| &h.id == id)
    }

    /// Adds a Host (`id: None`) or replaces the one with `id`, then saves.
    pub fn upsert(&mut self, id: Option<HostId>, draft: HostDraft) -> Result<Host, HostStoreError> {
        let mut hosts = self.hosts.clone();
        let host = match id {
            None => {
                let host = draft.into_host(HostId::generate())?;
                hosts.push(host.clone());
                host
            }
            Some(id) => {
                let slot = hosts
                    .iter_mut()
                    .find(|h| h.id == id)
                    .ok_or_else(|| HostStoreError::NotFound(id.clone()))?;
                *slot = draft.into_host(id)?;
                slot.clone()
            }
        };
        self.save(hosts)?;
        Ok(host)
    }

    pub fn delete(&mut self, id: &HostId) -> Result<(), HostStoreError> {
        let mut hosts = self.hosts.clone();
        let before = hosts.len();
        hosts.retain(|h| &h.id != id);
        if hosts.len() == before {
            return Err(HostStoreError::NotFound(id.clone()));
        }
        self.save(hosts)
    }

    /// Writes `hosts` and only then adopts them, so memory never runs ahead
    /// of the file.
    fn save(&mut self, hosts: Vec<Host>) -> Result<(), HostStoreError> {
        let json = serde_json::to_vec_pretty(&FileRef {
            version: CURRENT_VERSION,
            hosts: &hosts,
        })
        .map_err(|e| HostStoreError::Corrupt(e.to_string()))?;
        write_atomically(&self.path, &json).map_err(|source| HostStoreError::Io {
            path: self.path.clone(),
            source,
        })?;
        self.hosts = hosts;
        Ok(())
    }
}

/// Reads any supported file version into the current model.
fn migrate(text: &str) -> Result<Vec<Host>, HostStoreError> {
    let corrupt = |e: serde_json::Error| HostStoreError::Corrupt(e.to_string());
    let FileVersion { version } = serde_json::from_str(text).map_err(corrupt)?;
    match version {
        1 => Ok(serde_json::from_str::<FileV1>(text).map_err(corrupt)?.hosts),
        other => Err(HostStoreError::UnsupportedVersion(other)),
    }
}
