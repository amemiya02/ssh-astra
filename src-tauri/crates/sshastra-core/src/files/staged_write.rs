//! Write each transfer to a sibling file before publishing it at its final path.

use std::collections::HashMap;
use std::fmt::Write;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::hosts::HostId;

use super::{
    join, FileEntry, FileKind, FileReader, FileStat, FileWriter, FsError, FsResult, LocalFs,
    OpenRemote, RemoteFs,
};

/// A concrete path on either side of a transfer.
#[derive(Clone)]
pub(super) enum Side {
    Local(Arc<dyn LocalFs>, PathBuf),
    // The Host ID supplies an identity when the filesystem has no namespace.
    Remote(Arc<dyn RemoteFs>, String, Option<HostId>),
}

impl Side {
    pub(super) fn at(&self, rel: &str) -> Self {
        if rel.is_empty() {
            return self.clone();
        }
        match self {
            Self::Local(fs, root) => {
                let path = rel
                    .split('/')
                    .fold(root.clone(), |path, part| path.join(part));
                Self::Local(fs.clone(), path)
            }
            Self::Remote(fs, root, host) => Self::Remote(fs.clone(), join(root, rel), host.clone()),
        }
    }

    pub(super) fn display(&self) -> String {
        match self {
            Self::Local(_, path) => path.display().to_string(),
            Self::Remote(_, path, ..) => path.clone(),
        }
    }

    pub(super) async fn stat(&self) -> FsResult<FileStat> {
        match self {
            Self::Local(fs, path) => fs.stat(path).await,
            Self::Remote(fs, path, ..) => fs.stat(path).await,
        }
    }

    pub(super) async fn list_dir(&self) -> FsResult<Vec<FileEntry>> {
        match self {
            Self::Local(fs, path) => fs.list_dir(path).await,
            Self::Remote(fs, path, ..) => fs.list_dir(path).await,
        }
    }

    async fn open_read_at(&self, offset: u64) -> FsResult<FileReader> {
        match self {
            Self::Local(fs, path) => fs.open_read_at(path, offset).await,
            Self::Remote(fs, path, ..) => fs.open_read_at(path, offset).await,
        }
    }

    async fn open_write_at(&self, offset: u64) -> FsResult<FileWriter> {
        match self {
            Self::Local(fs, path) => fs.open_write_at(path, offset).await,
            Self::Remote(fs, path, ..) => fs.open_write_at(path, offset).await,
        }
    }

    async fn lstat(&self) -> FsResult<FileStat> {
        match self {
            Self::Local(fs, path) => fs.lstat(path).await,
            Self::Remote(fs, path, ..) => fs.lstat(path).await,
        }
    }

    pub(super) async fn canonicalize(&self) -> FsResult<Self> {
        match self {
            Self::Local(fs, path) => Ok(Self::Local(fs.clone(), fs.canonicalize(path).await?)),
            Self::Remote(fs, path, host) => Ok(Self::Remote(
                fs.clone(),
                fs.canonicalize(path).await?,
                host.clone(),
            )),
        }
    }

    pub(super) async fn canonicalize_parent(&self) -> FsResult<Self> {
        match self {
            Self::Local(fs, path) => {
                let name = path.file_name().ok_or_else(|| invalid_name(self))?;
                let parent = path
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or_else(|| Path::new("."));
                Ok(Self::Local(
                    fs.clone(),
                    fs.canonicalize(parent).await?.join(name),
                ))
            }
            Self::Remote(fs, path, host) => {
                let (parent, name) = path.rsplit_once('/').unwrap_or((".", path));
                let parent = if parent.is_empty() { "/" } else { parent };
                Ok(Self::Remote(
                    fs.clone(),
                    join(&fs.canonicalize(parent).await?, name),
                    host.clone(),
                ))
            }
        }
    }

    fn key(&self) -> StageKey {
        match self {
            Self::Local(_, path) => StageKey::Local(path.clone()),
            Self::Remote(fs, path, host) => {
                let namespace = fs
                    .transfer_namespace()
                    .map(|name| RemoteNamespace::Filesystem(name.to_owned()))
                    .or_else(|| host.clone().map(RemoteNamespace::Host));
                StageKey::Remote(namespace, path.clone())
            }
        }
    }

    pub(super) async fn create_dir(&self) -> FsResult<()> {
        match self {
            Self::Local(fs, path) => fs.create_dir(path).await,
            Self::Remote(fs, path, ..) => fs.create_dir(path).await,
        }
    }

    pub(super) fn sibling(&self) -> FsResult<Self> {
        let basename = match self {
            Self::Local(_, path) => path
                .file_name()
                .ok_or_else(|| invalid_name(self))?
                .as_encoded_bytes(),
            Self::Remote(_, path, ..) => path.rsplit('/').next().unwrap().as_bytes(),
        };
        Ok(self.with_name(&staging_name(basename)))
    }

    fn with_name(&self, name: &str) -> Self {
        match self {
            Self::Local(fs, path) => Self::Local(fs.clone(), path.with_file_name(name)),
            Self::Remote(fs, path, host) => {
                let sibling = path
                    .rsplit_once('/')
                    .map_or_else(|| name.to_owned(), |(parent, _)| join(parent, name));
                Self::Remote(fs.clone(), sibling, host.clone())
            }
        }
    }

    fn active_stage(&self) -> Self {
        let name = match self {
            Self::Local(_, path) => path.file_name().and_then(|name| name.to_str()),
            Self::Remote(_, path, ..) => path.rsplit('/').next(),
        }
        .expect("a retained staging name");
        let stem = name.strip_suffix(".part").expect("a retained staging name");
        self.with_name(&format!("{stem}-{}.part", Uuid::new_v4()))
    }

    async fn create_new(&self, private: bool) -> FsResult<FileWriter> {
        match self {
            Self::Local(fs, path) => fs.create_new(path, private).await,
            Self::Remote(fs, path, ..) => fs.create_new(path, private).await,
        }
    }

    async fn create_write(&self) -> FsResult<FileWriter> {
        match self {
            Self::Local(fs, path) => fs.create_write(path).await,
            Self::Remote(fs, path, ..) => fs.create_write(path).await,
        }
    }

    async fn set_permissions(&self, mode: u32) -> FsResult<()> {
        match self {
            Self::Local(fs, path) => fs.set_permissions(path, mode).await,
            Self::Remote(fs, path, ..) => fs.set_permissions(path, mode).await,
        }
    }

    async fn remove(&self) -> FsResult<()> {
        match self {
            Self::Local(fs, path) => fs.remove_file(path).await,
            Self::Remote(fs, path, ..) => fs.remove_file(path).await,
        }
    }

    async fn publish(&self, target: &Self, overwrite: bool) -> FsResult<()> {
        match (self, target) {
            (Self::Local(fs, from), Self::Local(_, to)) => {
                fs.publish_transfer(from, to, overwrite).await
            }
            (Self::Remote(fs, from, ..), Self::Remote(_, to, ..)) => {
                fs.publish_transfer(from, to, overwrite).await
            }
            _ => unreachable!("a staging file and its destination share a filesystem"),
        }
    }
}

fn staging_name(name: &[u8]) -> String {
    // Hashing bounds the length even for a final name at the filesystem limit.
    let mut path = String::from(".sshastra-");
    for byte in Sha256::digest(name) {
        write!(path, "{byte:02x}").expect("writing to a String cannot fail");
    }
    path.push_str(".part");
    path
}

fn invalid_name(side: &Side) -> FsError {
    FsError::Io(format!("{}: missing file name", side.display()))
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum StageKey {
    Local(PathBuf),
    Remote(Option<RemoteNamespace>, String),
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum RemoteNamespace {
    Filesystem(String),
    Host(HostId),
}

pub(super) type StageSlot = AsyncMutex<Option<Arc<Partial>>>;

/// Serializes copies and cleanup of known partials within a queue.
#[derive(Default)]
pub(super) struct StageSlots {
    slots: Mutex<HashMap<StageKey, Weak<StageSlot>>>,
}

impl StageSlots {
    pub(super) fn for_path(&self, temp: &Side) -> Arc<StageSlot> {
        let key = temp.key();
        let mut slots = self.slots.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(slot) = slots.get(&key).and_then(Weak::upgrade) {
            return slot;
        }
        slots.retain(|_, slot| slot.strong_count() != 0);
        let slot = Arc::new(StageSlot::default());
        slots.insert(key, Arc::downgrade(&slot));
        slot
    }
}

/// Records which copy owns the bytes and how to reach the staging path again.
/// In particular, it does not hold an old SFTP session open after a failure.
pub(super) struct Partial {
    source: Option<(StageKey, FileStat)>,
    location: PartialLocation,
    parked_stat: Option<FileStat>,
}

enum PartialLocation {
    Local(Arc<dyn LocalFs>, PathBuf),
    Remote(OpenRemote, Option<String>, String),
}

impl Partial {
    fn at(&self, current: &Side) -> Side {
        match (&self.location, current) {
            (PartialLocation::Local(_, path), Side::Local(fs, _)) => {
                Side::Local(fs.clone(), path.clone())
            }
            (PartialLocation::Remote(_, _, path), Side::Remote(fs, _, host)) => {
                Side::Remote(fs.clone(), path.clone(), host.clone())
            }
            _ => unreachable!("a partial stays on its destination filesystem"),
        }
    }
}

pub(super) struct StageLease {
    pub(super) slot: Arc<StageSlot>,
    pub(super) partial: Arc<Partial>,
    /// A paused transfer reserves its unique stage for its own resume.
    pub(super) reserved: bool,
}

impl StageLease {
    /// Returns whether a live Connection is needed to finish cleanup.
    pub(super) async fn discard(&self, live: Option<&dyn RemoteFs>) -> bool {
        let mut current = self.slot.lock().await;
        if !self.reserved
            && !current
                .as_ref()
                .is_some_and(|p| Arc::ptr_eq(p, &self.partial))
        {
            return false;
        }
        match &self.partial.location {
            PartialLocation::Local(fs, path) => {
                let expected = self.partial.parked_stat.as_ref();
                if expected.is_none() || fs.lstat(path).await.as_ref().ok() == expected {
                    let _ = fs.remove_file(path).await;
                }
            }
            PartialLocation::Remote(open, namespace, path) => {
                if let Some(fs) = live.filter(|fs| fs.transfer_namespace() == namespace.as_deref())
                {
                    if !connection_error(&self.discard_remote(fs, path).await) {
                        if !self.reserved {
                            *current = None;
                        }
                        return false;
                    }
                }
                let result = match tokio::time::timeout(Duration::from_secs(1), open()).await {
                    Ok(Ok(fs)) if fs.transfer_namespace() == namespace.as_deref() => {
                        self.discard_remote(fs.as_ref(), path).await
                    }
                    Ok(Ok(_)) => Ok(()),
                    Ok(Err(e)) => Err(e),
                    Err(_) => Err(FsError::TimedOut),
                };
                if connection_error(&result) {
                    return true;
                }
            }
        }
        if !self.reserved {
            *current = None;
        }
        false
    }

    async fn discard_remote(&self, fs: &dyn RemoteFs, path: &str) -> FsResult<()> {
        if let Some(expected) = &self.partial.parked_stat {
            if fs.lstat(path).await? != *expected {
                return Ok(());
            }
        }
        fs.remove_file(path).await
    }
}

fn connection_error<T>(result: &FsResult<T>) -> bool {
    matches!(
        result,
        Err(FsError::NotConnected | FsError::TimedOut | FsError::Protocol(_))
    )
}

/// A fixed amount of verification I/O, regardless of the partial file's size.
const CHECK_BYTES: u64 = 64 * 1024;

pub(super) struct WritePlan {
    reader: FileReader,
    offset: u64,
}

pub(super) enum OpenedWrite {
    Staged(FileReader, FileWriter, u64),
    NeedsInPlace(FileReader),
}

pub(super) struct StagedWrite<'a> {
    target: &'a Side,
    temp: Side,
    parked: Side,
    original: Option<FileStat>,
    claimed: bool,
    opened: bool,
    parked_stat: Option<FileStat>,
}

impl<'a> StagedWrite<'a> {
    pub(super) fn new(target: &'a Side, parked: Side, original: Option<FileStat>) -> Self {
        Self {
            target,
            temp: parked.active_stage(),
            parked,
            original,
            claimed: false,
            opened: false,
            parked_stat: None,
        }
    }

    /// Give the writable path a unique name before reading or changing existing
    /// bytes. Other processes can claim only quiescent files at the shared name.
    pub(super) async fn claim(&mut self, previous: Option<&Partial>) -> FsResult<()> {
        if let Some(previous) = previous.filter(|p| p.parked_stat.is_none()) {
            let owned = previous.at(&self.temp);
            match owned.lstat().await {
                Ok(_) => {
                    self.temp = owned;
                    self.claimed = true;
                    return Ok(());
                }
                Err(FsError::NotFound(_)) => {}
                Err(e) => return Err(e),
            }
        }
        match self.parked.lstat().await {
            Ok(stat) if matches!(stat.kind, FileKind::File | FileKind::Symlink) => {}
            Ok(_) => return Err(FsError::AlreadyExists(self.parked.display())),
            Err(FsError::NotFound(_) | FsError::PermissionDenied(_)) => return Ok(()),
            Err(e) => return Err(e),
        }
        match self.parked.publish(&self.temp, false).await {
            Ok(()) => self.claimed = true,
            Err(FsError::NotFound(_) | FsError::PermissionDenied(_)) => {}
            Err(e) => {
                // A lost reply can hide a successful move. The UUID path
                // belongs to us if it appeared, so the retry can check it.
                self.claimed = matches!(
                    e,
                    FsError::NotConnected | FsError::TimedOut | FsError::Protocol(_)
                );
                return Err(e);
            }
        }
        Ok(())
    }

    pub(super) async fn plan(
        &self,
        source: &Side,
        source_stat: &FileStat,
        previous: Option<&Partial>,
    ) -> FsResult<WritePlan> {
        let offset = if self.claimed {
            match self.temp.lstat().await {
                Ok(stat) if stat.kind == FileKind::File => {
                    let same_source = previous
                        .and_then(|p| p.source.as_ref())
                        .is_none_or(|(key, meta)| *key == source.key() && meta == source_stat);
                    let resume = same_source
                        && stat.size > 0
                        && stat.size <= source_stat.size
                        && matching_tail(&self.temp, source, stat.size).await?;
                    if resume {
                        stat.size
                    } else {
                        0
                    }
                }
                Ok(stat) if stat.kind == FileKind::Symlink => 0,
                Ok(_) => return Err(FsError::AlreadyExists(self.temp.display())),
                Err(FsError::NotFound(_)) => 0,
                Err(e) => return Err(e),
            }
        } else {
            0
        };
        let reader = source.open_read_at(offset).await?;
        Ok(WritePlan { reader, offset })
    }

    pub(super) async fn begin(
        &mut self,
        source: &Side,
        mut plan: WritePlan,
    ) -> FsResult<OpenedWrite> {
        let temp = &self.temp;
        if plan.offset != 0 {
            match temp.open_write_at(plan.offset).await {
                Ok(writer) => {
                    self.opened = true;
                    return Ok(OpenedWrite::Staged(plan.reader, writer, plan.offset));
                }
                Err(FsError::NotFound(_) | FsError::PermissionDenied(_)) => {
                    // A previous attempt may have set the final mode before
                    // its commit failed, making this file unwritable.
                    plan.reader = source.open_read_at(0).await?;
                }
                Err(e) => return Err(e),
            }
        }
        if self.claimed {
            match temp.remove().await {
                Ok(()) | Err(FsError::NotFound(_)) => self.claimed = false,
                Err(FsError::PermissionDenied(_)) if self.original.is_some() => {
                    return Ok(OpenedWrite::NeedsInPlace(plan.reader));
                }
                Err(e) => return Err(e),
            }
        }
        let writer = match temp.create_new(self.original.is_some()).await {
            Ok(writer) => {
                self.claimed = true;
                self.opened = true;
                writer
            }
            Err(FsError::PermissionDenied(_)) if self.original.is_some() => {
                return Ok(OpenedWrite::NeedsInPlace(plan.reader));
            }
            Err(e) => {
                // A lost SFTP reply may hide a successful creation.
                self.claimed = matches!(
                    e,
                    FsError::NotConnected | FsError::TimedOut | FsError::Protocol(_)
                );
                return Err(e);
            }
        };
        Ok(OpenedWrite::Staged(plan.reader, writer, 0))
    }

    pub(super) fn target(&self) -> &Side {
        self.target
    }

    pub(super) async fn begin_in_place(&self) -> FsResult<FileWriter> {
        self.target.create_write().await
    }

    /// A settled failed copy can be recovered by the next app run. If the
    /// connection is down or another copy already parked there, this row
    /// retains the unique name for its own retry and cleanup.
    pub(super) async fn park(&mut self) {
        if !self.claimed {
            return;
        }
        let Ok(stat) = self.temp.lstat().await else {
            return;
        };
        if !matches!(stat.kind, FileKind::File | FileKind::Symlink) {
            return;
        }
        if self.temp.publish(&self.parked, false).await.is_ok() {
            self.temp = self.parked.clone();
            self.parked_stat = Some(stat);
        }
    }

    pub(super) fn partial(
        &self,
        source: &Side,
        source_stat: &FileStat,
        open: Option<&OpenRemote>,
        previous: Option<&Partial>,
    ) -> Option<Partial> {
        if !self.claimed {
            return None;
        }
        let location = match &self.temp {
            Side::Local(fs, path) => PartialLocation::Local(fs.clone(), path.clone()),
            Side::Remote(fs, path, ..) => PartialLocation::Remote(
                open.expect("a remote destination has an opener").clone(),
                fs.transfer_namespace().map(String::from),
                path.clone(),
            ),
        };
        Some(Partial {
            // Claiming a partial only moves it. An error before opening the
            // writer must preserve the identity of the bytes it already held.
            source: if self.opened {
                Some((source.key(), source_stat.clone()))
            } else {
                previous.and_then(|p| p.source.clone())
            },
            location,
            parked_stat: self.parked_stat.clone(),
        })
    }

    pub(super) async fn prepare(&self) -> FsResult<()> {
        let Some(original) = &self.original else {
            return Ok(());
        };
        let permissions = match self.target.stat().await {
            Ok(stat) if stat.kind == FileKind::Dir => {
                return Err(FsError::NotADirectory(self.target.display()));
            }
            Ok(stat) => stat.permissions,
            Err(FsError::NotFound(_)) => original.permissions,
            Err(e) => return Err(e),
        };
        if let Some(mode) = permissions {
            // Set the final mode before publishing, so a chmod failure
            // leaves the original intact.
            self.temp.set_permissions(mode).await?;
        }
        Ok(())
    }

    pub(super) async fn commit(&self) -> FsResult<()> {
        self.temp
            .publish(self.target, self.original.is_some())
            .await
    }

    pub(super) async fn discard_unprotected(&self) {
        let _ = self.target.remove().await;
    }
}

async fn matching_tail(temp: &Side, source: &Side, size: u64) -> FsResult<bool> {
    let len = size.min(CHECK_BYTES);
    let offset = size - len;
    let Some(staged) = read_tail(temp, offset, len as usize).await? else {
        return Ok(false);
    };
    Ok(read_tail(source, offset, len as usize).await?.as_deref() == Some(staged.as_slice()))
}

async fn read_tail(side: &Side, offset: u64, len: usize) -> FsResult<Option<Vec<u8>>> {
    let mut reader = match side.open_read_at(offset).await {
        Ok(reader) => reader,
        Err(FsError::NotFound(_) | FsError::PermissionDenied(_)) => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut data = vec![0; len];
    match reader.read_exact(&mut data).await {
        Ok(_) => Ok(Some(data)),
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => Ok(None),
        Err(e) => Err(FsError::Io(format!("{}: {e}", side.display()))),
    }
}
