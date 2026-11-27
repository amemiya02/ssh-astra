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

use super::{
    join, FileEntry, FileKind, FileReader, FileStat, FileWriter, FsError, FsResult, LocalFs,
    OpenRemote, RemoteFs,
};

/// A concrete path on either side of a transfer.
#[derive(Clone)]
pub(super) enum Side {
    Local(Arc<dyn LocalFs>, PathBuf),
    Remote(Arc<dyn RemoteFs>, String),
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
            Self::Remote(fs, root) => Self::Remote(fs.clone(), join(root, rel)),
        }
    }

    pub(super) fn display(&self) -> String {
        match self {
            Self::Local(_, path) => path.display().to_string(),
            Self::Remote(_, path) => path.clone(),
        }
    }

    pub(super) async fn stat(&self) -> FsResult<FileStat> {
        match self {
            Self::Local(fs, path) => fs.stat(path).await,
            Self::Remote(fs, path) => fs.stat(path).await,
        }
    }

    pub(super) async fn list_dir(&self) -> FsResult<Vec<FileEntry>> {
        match self {
            Self::Local(fs, path) => fs.list_dir(path).await,
            Self::Remote(fs, path) => fs.list_dir(path).await,
        }
    }

    async fn open_read_at(&self, offset: u64) -> FsResult<FileReader> {
        match self {
            Self::Local(fs, path) => fs.open_read_at(path, offset).await,
            Self::Remote(fs, path) => fs.open_read_at(path, offset).await,
        }
    }

    async fn open_write_at(&self, offset: u64) -> FsResult<FileWriter> {
        match self {
            Self::Local(fs, path) => fs.open_write_at(path, offset).await,
            Self::Remote(fs, path) => fs.open_write_at(path, offset).await,
        }
    }

    async fn lstat(&self) -> FsResult<FileStat> {
        match self {
            Self::Local(fs, path) => fs.lstat(path).await,
            Self::Remote(fs, path) => fs.lstat(path).await,
        }
    }

    pub(super) async fn canonicalize(&self) -> FsResult<Self> {
        match self {
            Self::Local(fs, path) => Ok(Self::Local(fs.clone(), fs.canonicalize(path).await?)),
            Self::Remote(fs, path) => Ok(Self::Remote(fs.clone(), fs.canonicalize(path).await?)),
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
            Self::Remote(fs, path) => {
                let (parent, name) = path.rsplit_once('/').unwrap_or((".", path));
                let parent = if parent.is_empty() { "/" } else { parent };
                Ok(Self::Remote(
                    fs.clone(),
                    join(&fs.canonicalize(parent).await?, name),
                ))
            }
        }
    }

    fn key(&self) -> StageKey {
        match self {
            Self::Local(_, path) => StageKey::Local(path.clone()),
            Self::Remote(fs, path) => {
                StageKey::Remote(fs.transfer_namespace().map(String::from), path.clone())
            }
        }
    }

    pub(super) async fn create_dir(&self) -> FsResult<()> {
        match self {
            Self::Local(fs, path) => fs.create_dir(path).await,
            Self::Remote(fs, path) => fs.create_dir(path).await,
        }
    }

    pub(super) fn sibling(&self) -> FsResult<Self> {
        match self {
            Self::Local(fs, path) => {
                let name = path.file_name().ok_or_else(|| invalid_name(self))?;
                Ok(Self::Local(
                    fs.clone(),
                    path.with_file_name(staging_name(name.as_encoded_bytes())),
                ))
            }
            Self::Remote(fs, path) => {
                let basename = path.rsplit('/').next().expect("split always yields a name");
                let name = staging_name(basename.as_bytes());
                let sibling = path
                    .rsplit_once('/')
                    .map_or_else(|| name.clone(), |(parent, _)| join(parent, &name));
                Ok(Self::Remote(fs.clone(), sibling))
            }
        }
    }

    async fn create_new(&self, private: bool) -> FsResult<FileWriter> {
        match self {
            Self::Local(fs, path) => fs.create_new(path, private).await,
            Self::Remote(fs, path) => fs.create_new(path, private).await,
        }
    }

    async fn create_write(&self) -> FsResult<FileWriter> {
        match self {
            Self::Local(fs, path) => fs.create_write(path).await,
            Self::Remote(fs, path) => fs.create_write(path).await,
        }
    }

    async fn set_permissions(&self, mode: u32) -> FsResult<()> {
        match self {
            Self::Local(fs, path) => fs.set_permissions(path, mode).await,
            Self::Remote(fs, path) => fs.set_permissions(path, mode).await,
        }
    }

    async fn remove(&self) -> FsResult<()> {
        match self {
            Self::Local(fs, path) => fs.remove_file(path).await,
            Self::Remote(fs, path) => fs.remove_file(path).await,
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

#[derive(PartialEq, Eq, Hash)]
enum StageKey {
    Local(PathBuf),
    Remote(Option<String>, String),
}

pub(super) type StageSlot = AsyncMutex<Option<Arc<Partial>>>;

/// Serializes copies and cleanup using the same deterministic staging path.
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
    source: StageKey,
    source_stat: FileStat,
    location: PartialLocation,
}

enum PartialLocation {
    Local(Arc<dyn LocalFs>, PathBuf),
    Remote(OpenRemote, Option<String>, String),
}

pub(super) struct StageLease {
    pub(super) slot: Arc<StageSlot>,
    pub(super) partial: Arc<Partial>,
}

impl StageLease {
    /// Returns whether a live Connection is needed to finish cleanup.
    pub(super) async fn discard(&self, live: Option<&dyn RemoteFs>) -> bool {
        let mut current = self.slot.lock().await;
        if !current
            .as_ref()
            .is_some_and(|p| Arc::ptr_eq(p, &self.partial))
        {
            return false;
        }
        match &self.partial.location {
            PartialLocation::Local(fs, path) => {
                let _ = fs.remove_file(path).await;
            }
            PartialLocation::Remote(open, namespace, path) => {
                if let Some(fs) = live.filter(|fs| fs.transfer_namespace() == namespace.as_deref())
                {
                    if !connection_error(&fs.remove_file(path).await) {
                        *current = None;
                        return false;
                    }
                }
                let result = match tokio::time::timeout(Duration::from_secs(1), open()).await {
                    Ok(Ok(fs)) if fs.transfer_namespace() == namespace.as_deref() => {
                        fs.remove_file(path).await
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
        *current = None;
        false
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
    existing: bool,
    offset: u64,
}

pub(super) struct StagedWrite<'a> {
    target: &'a Side,
    temp: Option<Side>,
    original: Option<FileStat>,
    claimed: bool,
}

impl<'a> StagedWrite<'a> {
    pub(super) fn new(target: &'a Side, temp: Side, original: Option<FileStat>) -> Self {
        Self {
            target,
            temp: Some(temp),
            original,
            claimed: false,
        }
    }

    pub(super) async fn plan(
        &self,
        source: &Side,
        source_stat: &FileStat,
        previous: Option<&Partial>,
    ) -> FsResult<WritePlan> {
        let temp = self.temp.as_ref().expect("planning precedes staging");
        let (existing, offset) = match temp.lstat().await {
            Ok(stat) if stat.kind == FileKind::File => {
                let same_source = previous
                    .is_none_or(|p| p.source == source.key() && p.source_stat == *source_stat);
                let resume = same_source
                    && stat.size > 0
                    && stat.size <= source_stat.size
                    && matching_tail(temp, source, stat.size).await?;
                (true, if resume { stat.size } else { 0 })
            }
            Ok(stat) if stat.kind == FileKind::Symlink => (true, 0),
            Ok(_) => return Err(FsError::AlreadyExists(temp.display())),
            Err(FsError::NotFound(_)) => (false, 0),
            Err(e) => return Err(e),
        };
        let reader = source.open_read_at(offset).await?;
        Ok(WritePlan {
            reader,
            existing,
            offset,
        })
    }

    pub(super) async fn begin(
        &mut self,
        source: &Side,
        mut plan: WritePlan,
    ) -> FsResult<(FileReader, FileWriter, u64)> {
        let temp = self.temp.as_ref().expect("staging starts once");
        if plan.offset != 0 {
            match temp.open_write_at(plan.offset).await {
                Ok(writer) => {
                    self.claimed = true;
                    return Ok((plan.reader, writer, plan.offset));
                }
                Err(FsError::NotFound(_) | FsError::PermissionDenied(_)) => {
                    // A previous attempt may have set the final mode before
                    // its commit failed, making this file unwritable.
                    plan.reader = source.open_read_at(0).await?;
                }
                Err(e) => return Err(e),
            }
        }
        if plan.existing {
            match temp.remove().await {
                Ok(()) | Err(FsError::NotFound(_)) => {}
                Err(e) => return Err(e),
            }
        }
        let writer = match temp.create_new(self.original.is_some()).await {
            Ok(writer) => {
                self.claimed = true;
                writer
            }
            Err(FsError::PermissionDenied(_)) if self.original.is_some() => {
                self.temp = None;
                self.target.create_write().await?
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
        Ok((plan.reader, writer, 0))
    }

    pub(super) fn target(&self) -> &Side {
        self.target
    }

    pub(super) fn unprotected(&self) -> bool {
        self.temp.is_none()
    }

    pub(super) fn partial(
        &self,
        source: &Side,
        source_stat: &FileStat,
        open: &OpenRemote,
    ) -> Option<Partial> {
        let temp = self.temp.as_ref().filter(|_| self.claimed)?;
        let location = match temp {
            Side::Local(fs, path) => PartialLocation::Local(fs.clone(), path.clone()),
            Side::Remote(fs, path) => PartialLocation::Remote(
                open.clone(),
                fs.transfer_namespace().map(String::from),
                path.clone(),
            ),
        };
        Some(Partial {
            source: source.key(),
            source_stat: source_stat.clone(),
            location,
        })
    }

    pub(super) async fn prepare(&self) -> FsResult<()> {
        let (Some(temp), Some(original)) = (&self.temp, &self.original) else {
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
            temp.set_permissions(mode).await?;
        }
        Ok(())
    }

    pub(super) async fn commit(&self) -> FsResult<()> {
        match (&self.temp, self.target) {
            (None, _) => Ok(()),
            (Some(Side::Local(fs, from)), Side::Local(_, to)) => {
                fs.publish_transfer(from, to, self.original.is_some()).await
            }
            (Some(Side::Remote(fs, from)), Side::Remote(_, to)) => {
                fs.publish_transfer(from, to, self.original.is_some()).await
            }
            _ => unreachable!("a staging file and its destination share a filesystem"),
        }
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
