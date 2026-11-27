//! Local activity metadata for MCP tools. The recorder never receives arguments
//! before validation, RPC frames, tool responses, or backend diagnostics.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read};
use std::ops::Bound::{Excluded, Unbounded};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    bound_metadata, ReadTarget, COMMAND_REVIEW_TOOL, HOST_NAME_BYTE_LIMIT, PATH_BYTE_LIMIT,
    WRITE_FILE_TOOL,
};
use crate::fs_util::write_atomically_private;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const RETENTION_MS: u64 = 30 * DAY_MS;
const RECORDS_PER_SHARD: usize = 32;
const PAGE_SIZE: usize = 50;
// JSON can use up to six bytes to escape one byte of metadata.
const MAX_FILE_BYTES: usize =
    RECORDS_PER_SHARD * (6 * (HOST_NAME_BYTE_LIMIT + PATH_BYTE_LIMIT) + 128) + 2;

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Tool {
    ListTerminals,
    ReadTerminal,
    ListDirectory,
    ReadFile,
    RequestCommandReview,
    WriteFile,
    Unknown,
}

impl Tool {
    pub(super) fn from_name(name: Option<&str>) -> Self {
        match name {
            Some("list_terminals") => Self::ListTerminals,
            Some("read_terminal") => Self::ReadTerminal,
            Some("list_directory") => Self::ListDirectory,
            Some("read_file") => Self::ReadFile,
            Some(COMMAND_REVIEW_TOOL) => Self::RequestCommandReview,
            Some(WRITE_FILE_TOOL) => Self::WriteFile,
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

/// An exclusive page boundary between shards. Concurrent calls can
/// append to the latest shard without moving this boundary.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub struct ActivityCursor {
    day: u64,
    segment: u32,
}

impl ActivityCursor {
    fn last_in(day: u64) -> Self {
        Self {
            day,
            segment: u32::MAX,
        }
    }

    fn filename(self) -> String {
        format!("{}-{}.json", self.day, self.segment)
    }

    fn parse(filename: &str) -> Option<Self> {
        let (day, segment) = filename.strip_suffix(".json")?.split_once('-')?;
        let cursor = Self {
            day: day.parse().ok()?,
            segment: segment.parse().ok()?,
        };
        (cursor.filename() == filename).then_some(cursor)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPage {
    pub records: Vec<ActivityRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_before: Option<ActivityCursor>,
}

type Shards = BTreeMap<ActivityCursor, Option<u64>>;

#[derive(Default)]
struct Archive {
    initialized: bool,
    // Earliest timestamp cached on demand for shards on the cutoff day.
    shards: Shards,
}

pub struct AgentActivityLog {
    directory: PathBuf,
    /// Serialize app-wide updates, expiration and clears with each other.
    archive: Mutex<Archive>,
}

impl AgentActivityLog {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            archive: Mutex::new(Archive::default()),
        }
    }

    /// Expires old records without loading a page for display.
    pub fn prune(&self, now: SystemTime) -> io::Result<()> {
        self.expire(&mut self.open()?.shards, timestamp(now))
    }

    /// Returns a page newest first and removes expired entries from disk.
    pub fn list(
        &self,
        now: SystemTime,
        before: Option<ActivityCursor>,
    ) -> io::Result<ActivityPage> {
        let mut archive = self.open()?;
        self.expire(&mut archive.shards, timestamp(now))?;
        let upper = before.map_or(Unbounded, Excluded);
        let mut shards = archive.shards.range((Unbounded, upper)).rev().peekable();
        let mut records = Vec::new();
        let mut last = None;
        while records.len() < PAGE_SIZE {
            let Some((&shard, _)) = shards.next() else {
                break;
            };
            records.extend(self.read(shard)?);
            last = Some(shard);
        }
        Ok(ActivityPage {
            records,
            next_before: last.filter(|_| shards.peek().is_some()),
        })
    }

    pub fn record(&self, call: ActivityCall, now: SystemTime) -> io::Result<()> {
        let mut archive = self.open()?;
        let timestamp = timestamp(now);
        self.expire(&mut archive.shards, timestamp)?;
        let day = timestamp / DAY_MS;
        let current = archive
            .shards
            .range(..=ActivityCursor::last_in(day))
            .next_back()
            .map(|(&shard, _)| shard)
            .filter(|shard| shard.day == day);
        let mut shard = current.unwrap_or(ActivityCursor { day, segment: 0 });
        let mut records = match current {
            Some(shard) => self.read(shard)?,
            None => Vec::new(),
        };
        if records.len() == RECORDS_PER_SHARD {
            shard.segment = shard
                .segment
                .checked_add(1)
                .ok_or_else(|| io::Error::other("Too many Agent access activity shards"))?;
            records.clear();
        }
        records.insert(
            0,
            ActivityRecord {
                timestamp,
                details: call.0,
            },
        );
        self.write(shard, &records)?;
        archive.shards.insert(shard, earliest(&records));
        Ok(())
    }

    pub fn clear(&self) -> io::Result<()> {
        let mut archive = self.lock();
        let cleared = self.directory.join("cleared");
        remove_directory(&cleared)?;
        match fs::rename(self.records_dir(), &cleared) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        archive.shards.clear();
        archive.initialized = true;
        remove_directory(&cleared)
    }

    fn lock(&self) -> MutexGuard<'_, Archive> {
        self.archive.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn open(&self) -> io::Result<MutexGuard<'_, Archive>> {
        let mut archive = self.lock();
        if !archive.initialized {
            remove_directory(&self.directory.join("cleared"))?;
            archive.shards = self.scan()?;
            archive.initialized = true;
        }
        Ok(archive)
    }

    fn scan(&self) -> io::Result<Shards> {
        let directory = match fs::read_dir(self.records_dir()) {
            Ok(directory) => directory,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Shards::new()),
            Err(error) => return Err(error),
        };
        let mut shards = Shards::new();
        for entry in directory {
            let entry = entry?;
            let filename = entry.file_name();
            let Some(filename) = filename.to_str() else {
                continue;
            };
            if let Some(shard) = ActivityCursor::parse(filename) {
                shards.insert(shard, None);
            } else if is_staged_shard(filename) {
                // A previous process can exit before its atomic replace.
                fs::remove_file(entry.path())?;
            }
        }
        Ok(shards)
    }

    fn records_dir(&self) -> PathBuf {
        self.directory.join("records")
    }

    fn read(&self, shard: ActivityCursor) -> io::Result<Vec<ActivityRecord>> {
        let file = File::open(self.records_dir().join(shard.filename()))?;
        let mut contents = Vec::new();
        file.take((MAX_FILE_BYTES + 1) as u64)
            .read_to_end(&mut contents)?;
        if contents.len() <= MAX_FILE_BYTES {
            if let Ok(records) = serde_json::from_slice::<Vec<ActivityRecord>>(&contents) {
                if records.len() <= RECORDS_PER_SHARD {
                    return Ok(records);
                }
            }
        }
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "The Agent access activity file is damaged",
        ))
    }

    fn write(&self, shard: ActivityCursor, records: &[ActivityRecord]) -> io::Result<()> {
        let directory = self.records_dir();
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory)?;
        let contents = serde_json::to_vec(records).map_err(io::Error::other)?;
        write_atomically_private(&directory.join(shard.filename()), &contents)
    }

    fn expire(&self, shards: &mut Shards, now: u64) -> io::Result<()> {
        let cutoff = now.saturating_sub(RETENTION_MS);
        let day = cutoff / DAY_MS;
        while let Some((&shard, _)) = shards.first_key_value() {
            if shard.day >= day {
                break;
            }
            self.remove(shard)?;
            shards.remove(&shard);
        }
        let boundary: Vec<_> = shards
            .range(..=ActivityCursor::last_in(day))
            .filter(|(_, earliest)| earliest.is_none_or(|time| time < cutoff))
            .map(|(&shard, _)| shard)
            .collect();
        for shard in boundary {
            let mut records = self.read(shard)?;
            let before = records.len();
            records.retain(|record| record.timestamp >= cutoff);
            if records.is_empty() {
                self.remove(shard)?;
                shards.remove(&shard);
            } else {
                if records.len() != before {
                    self.write(shard, &records)?;
                }
                shards.insert(shard, earliest(&records));
            }
        }
        Ok(())
    }

    fn remove(&self, shard: ActivityCursor) -> io::Result<()> {
        match fs::remove_file(self.records_dir().join(shard.filename())) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }
}

fn is_staged_shard(filename: &str) -> bool {
    let Some((shard, id)) = filename
        .strip_prefix('.')
        .and_then(|filename| filename.strip_suffix(".tmp"))
        .and_then(|filename| filename.rsplit_once('.'))
    else {
        return false;
    };
    ActivityCursor::parse(shard).is_some() && Uuid::parse_str(id).is_ok()
}

fn remove_directory(path: &std::path::Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn timestamp(now: SystemTime) -> u64 {
    now.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn earliest(records: &[ActivityRecord]) -> Option<u64> {
    records.iter().map(|record| record.timestamp).min()
}
