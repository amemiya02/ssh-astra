//! Local activity metadata for MCP tools. The recorder never receives arguments
//! before validation, RPC frames, tool responses, or backend diagnostics.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::{bound_metadata, ReadTarget, HOST_NAME_BYTE_LIMIT, PATH_BYTE_LIMIT};
use crate::fs_util::write_atomically_private;

const RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORDS: usize = 500;
// JSON can use up to six bytes to escape one byte of metadata.
const MAX_FILE_BYTES: usize =
    MAX_RECORDS * (6 * (HOST_NAME_BYTE_LIMIT + PATH_BYTE_LIMIT) + 128) + 2;

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Tool {
    ListTerminals,
    ReadTerminal,
    ListDirectory,
    ReadFile,
    Unknown,
}

impl Tool {
    pub(super) fn from_name(name: Option<&str>) -> Self {
        match name {
            Some("list_terminals") => Self::ListTerminals,
            Some("read_terminal") => Self::ReadTerminal,
            Some("list_directory") => Self::ListDirectory,
            Some("read_file") => Self::ReadFile,
            _ => Self::Unknown,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Outcome {
    Allowed,
    Denied,
    TimedOut,
    Failed,
}

#[derive(Serialize, Deserialize)]
struct ActivityDetails {
    tool: Tool,
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    outcome: Outcome,
}

/// The call's allowlisted metadata, as established by dispatch.
pub struct ActivityCall(ActivityDetails);

impl ActivityCall {
    pub(super) fn new(tool: Tool) -> Self {
        Self(ActivityDetails {
            tool,
            host: None,
            path: None,
            // The service can revoke access and cancel a call before it finishes.
            outcome: Outcome::Denied,
        })
    }

    pub(super) fn set_target(&mut self, target: &ReadTarget, path: Option<&str>) {
        self.0.host = Some(bound_metadata(
            target.host_name.clone(),
            HOST_NAME_BYTE_LIMIT,
        ));
        self.0.path = path.map(str::to_owned);
    }

    pub(super) fn finish(&mut self, outcome: Outcome) {
        self.0.outcome = outcome;
    }

    /// Called by the local transport when the dispatch deadline expires.
    pub fn timed_out(&mut self) {
        self.finish(Outcome::TimedOut);
    }
}

#[derive(Serialize, Deserialize)]
pub struct ActivityRecord {
    timestamp: u64,
    #[serde(flatten)]
    details: ActivityDetails,
}

pub struct AgentActivityLog {
    path: PathBuf,
    /// Serialize app-wide updates, expiration and clears with each other.
    access: Mutex<()>,
}

impl AgentActivityLog {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            access: Mutex::new(()),
        }
    }

    /// Returns the newest calls first and removes expired entries from disk.
    pub fn list(&self, now: SystemTime) -> io::Result<Vec<ActivityRecord>> {
        let _lock = self.access.lock().unwrap_or_else(|p| p.into_inner());
        let mut records = self.read()?;
        let before = records.len();
        prune(&mut records, timestamp(now));
        if records.len() != before {
            self.write(&records)?;
        }
        Ok(records)
    }

    pub fn record(&self, call: ActivityCall, now: SystemTime) -> io::Result<()> {
        let _lock = self.access.lock().unwrap_or_else(|p| p.into_inner());
        let mut records = self.read()?;
        let timestamp = timestamp(now);
        prune(&mut records, timestamp);
        records.truncate(MAX_RECORDS - 1);
        records.insert(
            0,
            ActivityRecord {
                timestamp,
                details: call.0,
            },
        );
        self.write(&records)
    }

    pub fn clear(&self) -> io::Result<()> {
        let _lock = self.access.lock().unwrap_or_else(|p| p.into_inner());
        self.remove()
    }

    fn read(&self) -> io::Result<Vec<ActivityRecord>> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut contents = Vec::new();
        file.take((MAX_FILE_BYTES + 1) as u64)
            .read_to_end(&mut contents)?;
        if contents.len() <= MAX_FILE_BYTES {
            if let Ok(records) = serde_json::from_slice(&contents) {
                return Ok(records);
            }
        }
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "The Agent access activity file is damaged",
        ))
    }

    fn write(&self, records: &[ActivityRecord]) -> io::Result<()> {
        if records.is_empty() {
            return self.remove();
        }
        let contents = serde_json::to_vec(records).map_err(io::Error::other)?;
        write_atomically_private(&self.path, &contents)
    }

    fn remove(&self) -> io::Result<()> {
        match fs::remove_file(&self.path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }
}

fn timestamp(now: SystemTime) -> u64 {
    now.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn prune(records: &mut Vec<ActivityRecord>, now: u64) {
    let cutoff = now.saturating_sub(RETENTION_MS);
    records.retain(|record| record.timestamp >= cutoff);
    records.truncate(MAX_RECORDS);
}
