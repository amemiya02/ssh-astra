//! Remote file systems: what the File panel browses, and what file
//! operations, transfers and remote editing act on.
//!
//! [`RemoteFs`] is the seam: [`SftpFs`] implements it over a Host's
//! Connection (`Connection::open_sftp`), and tests may swap in an in-memory
//! fake. Paths are POSIX strings as the server sees them.

mod archive;
mod live;
mod local;
mod registry;
mod sftp;
mod staged_write;
mod transfer;

pub use live::LiveHostFs;
pub use local::{DiskBrowser, DiskFs, LocalFs};
pub use registry::{FsId, FsRegistry};
pub use sftp::SftpFs;
pub use transfer::{
    ConflictAnswer, OpenRemote, RemoteTransfer, Transfer, TransferDirection, TransferHost,
    TransferId, TransferQueue, TransferSettings, TransferState,
};

use std::future::Future;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::oneshot;

use crate::ssh::BoxFuture;

/// What a path is. A symlink is reported as such by [`RemoteFs::list_dir`]
/// (with its target's kind in [`FileEntry::link_target`]); [`RemoteFs::stat`]
/// follows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    File,
    Dir,
    Symlink,
    /// Sockets, devices, FIFOs.
    Other,
}

/// A path's metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub kind: FileKind,
    /// Bytes; 0 when the server does not say.
    pub size: u64,
    /// Seconds since the Unix epoch.
    pub modified: Option<u64>,
    /// Permission bits only (`0o755`), without the file type.
    pub permissions: Option<u32>,
}

/// One entry of a directory listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub kind: FileKind,
    pub size: u64,
    pub modified: Option<u64>,
    pub permissions: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    /// For a symlink, the kind of what it points to (`None` if it dangles);
    /// `None` for anything else.
    pub link_target: Option<FileKind>,
}

/// A directory's resolved absolute path and its entries (unordered, without
/// `.` and `..`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

/// How a name search matches an entry's basename. Matching is case-sensitive.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NameSearchMode {
    Substring,
    /// `*` matches any run of characters, and `?` matches one character.
    Wildcard,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameMatch {
    pub parent: String,
    pub name: String,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameSearchResult {
    pub matches: Vec<NameMatch>,
    pub visited: usize,
    pub limit_reached: bool,
    pub skipped_directories: bool,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionScope {
    #[default]
    Entry,
    Recursive,
    DirectoriesOnly,
}

/// Ownership edits apply to the selected entry. The scope governs the mode change.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionChange {
    pub mode: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    #[serde(default)]
    pub scope: PermissionScope,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FsError {
    /// The Host has no live Connection to browse over.
    #[error("not connected")]
    NotConnected,
    #[error("no such file or directory: {0}")]
    NotFound(String),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("ownership is unavailable: {0}")]
    OwnershipUnavailable(String),
    #[error("not a directory: {0}")]
    NotADirectory(String),
    /// Creating or renaming onto a name that is already taken.
    #[error("already exists: {0}")]
    AlreadyExists(String),
    #[error("invalid file name")]
    InvalidName,
    #[error("archive operations require an SSH Connection")]
    ArchiveUnavailable,
    #[error("unsupported archive name: {0}")]
    ArchiveUnsupported(String),
    #[error("the archive is missing or is not a file")]
    ArchiveNotAFile,
    #[error("{0} is missing on the Host")]
    ArchiveToolMissing(&'static str),
    #[error("{0}")]
    ArchiveFailed(String),
    #[error("{message}")]
    ArchiveIncomplete { path: String, message: String },
    /// A file bigger than a whole-file read allows ([`READ_FILE_LIMIT`]).
    #[error("{path} is larger than {limit} bytes")]
    TooLarge { path: String, limit: u64 },
    #[error("the server did not answer in time")]
    TimedOut,
    /// The SFTP session or its Connection failed, or the server refused
    /// for another reason.
    #[error("SFTP error: {0}")]
    Protocol(String),
    /// A local file could not be read or written.
    #[error("{0}")]
    Io(String),
}

impl FsError {
    /// Log the category without including a path or a server error payload.
    pub(crate) fn log_kind(&self) -> &'static str {
        match self {
            Self::NotConnected => "notConnected",
            Self::NotFound(_) => "notFound",
            Self::PermissionDenied(_) => "permissionDenied",
            Self::OwnershipUnavailable(_) => "ownershipUnavailable",
            Self::NotADirectory(_) => "notADirectory",
            Self::AlreadyExists(_) => "alreadyExists",
            Self::InvalidName => "invalidName",
            Self::ArchiveUnavailable => "archiveUnavailable",
            Self::ArchiveUnsupported(_) => "archiveUnsupported",
            Self::ArchiveNotAFile => "archiveNotAFile",
            Self::ArchiveToolMissing(_) => "archiveToolMissing",
            Self::ArchiveFailed(_) => "archiveFailed",
            Self::ArchiveIncomplete { .. } => "archiveIncomplete",
            Self::TooLarge { .. } => "tooLarge",
            Self::TimedOut => "timedOut",
            Self::Protocol(_) => "protocol",
            Self::Io(_) => "io",
        }
    }
}

pub type FsResult<T> = Result<T, FsError>;

/// The most [`RemoteFs::read_file`] reads into memory: 10 MB.
pub const READ_FILE_LIMIT: u64 = 10 * 1024 * 1024;

/// A file opened for streaming reads ([`RemoteFs::open_read`],
/// [`LocalFs::open_read`]).
pub type FileReader = Box<dyn AsyncRead + Send + Unpin>;

/// A file opened for streaming writes ([`RemoteFs::create_write`],
/// [`LocalFs::create_write`]). Call `shutdown().await` when done: that
/// flushes and closes it, and reports a failed close.
pub type FileWriter = Box<dyn AsyncWrite + Send + Unpin>;

/// A Host's file system as the File panel sees it. Object safe, so callers
/// hold an `Arc<dyn RemoteFs>` and tests can pass a fake.
pub trait RemoteFs: Send + Sync {
    /// Identifies a remote filesystem across Connections for transfer staging.
    fn transfer_namespace(&self) -> Option<&str> {
        None
    }

    /// Whether a streamed read or write failed because its Connection ended.
    fn transfer_connection_lost(&self, _error: &std::io::Error) -> bool {
        false
    }

    /// The directory a new File panel opens in: the user's home directory.
    fn home(&self) -> BoxFuture<'_, FsResult<String>>;
    /// `path` made absolute (relative to the home directory), with `.`, `..`
    /// and symlinks resolved by the server.
    fn canonicalize<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<String>>;
    /// The entries of the directory `path`.
    fn list_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<Vec<FileEntry>>>;
    /// Entries for traversal, with no lookups of symlink targets.
    fn list_dir_no_follow<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<Vec<FileEntry>>> {
        self.list_dir(path)
    }
    /// The metadata of `path`, following symlinks.
    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileStat>>;
    /// The metadata of `path` itself: a symlink is [`FileKind::Symlink`].
    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileStat>>;

    /// Sums regular file sizes inside a folder, without following symlinks.
    /// Sending or dropping the cancellation sender stops the scan and returns `None`.
    fn folder_size<'a>(
        &'a self,
        path: &'a str,
        cancelled: oneshot::Receiver<()>,
    ) -> BoxFuture<'a, FsResult<Option<u64>>> {
        Box::pin(cancellable_scan(cancelled, sum_folder(self, path)))
    }

    /// Finds descendant names on SFTP within a bounded scan, without traversing symlinks.
    /// Sending or dropping the cancellation sender stops the scan and returns `None`.
    fn search_names<'a>(
        &'a self,
        _path: &'a str,
        _query: &'a str,
        _mode: NameSearchMode,
        _cancelled: oneshot::Receiver<()>,
    ) -> BoxFuture<'a, FsResult<Option<NameSearchResult>>> {
        Box::pin(async { Err(FsError::Protocol("name search requires SFTP".into())) })
    }

    /// Creates the directory `path` (its parent must exist).
    fn create_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>>;
    /// Creates an empty file at `path`; fails with [`FsError::AlreadyExists`]
    /// if any entry already occupies that path.
    fn create_empty_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            let mut writer = self.create_new(path, false).await?;
            writer
                .shutdown()
                .await
                .map_err(|e| FsError::Protocol(format!("{path}: {e}")))
        })
    }

    /// Renames (or moves) `from` to `to`; fails with
    /// [`FsError::AlreadyExists`] rather than replacing an existing `to`.
    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, FsResult<()>>;
    /// Packs direct children of the absolute directory into a new `.tar.gz`.
    /// Both the selected entries and the output are leaf names in that directory.
    fn compress<'a>(
        &'a self,
        _directory: &'a str,
        _names: &'a [String],
        _archive: &'a str,
    ) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async { Err(FsError::ArchiveUnavailable) })
    }

    /// Expands a named archive in the absolute directory into a new sibling
    /// directory named for the archive without its extension.
    fn extract_archive<'a>(
        &'a self,
        _directory: &'a str,
        _archive: &'a str,
    ) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async { Err(FsError::ArchiveUnavailable) })
    }

    /// Deletes a file or symlink (never what it points to).
    fn remove_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>>;
    /// Deletes an empty directory; see [`remove_tree`] for a full one.
    fn remove_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>>;
    /// Sets the permission bits (`0o755`) of `path`, following symlinks.
    fn set_permissions<'a>(&'a self, path: &'a str, mode: u32) -> BoxFuture<'a, FsResult<()>>;
    /// Sets the requested numeric IDs and keeps either omitted ID.
    fn set_ownership<'a>(
        &'a self,
        path: &'a str,
        _uid: Option<u32>,
        _gid: Option<u32>,
    ) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { Err(FsError::OwnershipUnavailable(path.to_owned())) })
    }

    // Contents, streamed (transfers); `read_file` / `write_file` wrap them.

    /// Opens the file `path` to read it from the start.
    fn open_read<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileReader>> {
        self.open_read_at(path, 0)
    }
    /// Opens a file to read from the given byte offset.
    fn open_read_at<'a>(
        &'a self,
        path: &'a str,
        offset: u64,
    ) -> BoxFuture<'a, FsResult<FileReader>>;
    /// Opens an existing regular file to write from the given offset without
    /// truncating it. For a staging file, the caller also checks `lstat`.
    fn open_write_at<'a>(
        &'a self,
        path: &'a str,
        offset: u64,
    ) -> BoxFuture<'a, FsResult<FileWriter>>;

    /// Creates the file `path`, or empties it if it exists (keeping its
    /// permissions), to write it. Finish with `shutdown().await`.
    fn create_write<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileWriter>>;

    /// Exclusively creates a file. Existing paths, including
    /// symlinks, are never opened. Private files are created with mode `0o600`.
    fn create_new<'a>(
        &'a self,
        path: &'a str,
        private: bool,
    ) -> BoxFuture<'a, FsResult<FileWriter>>;

    /// Publishes a staged transfer. This is separate from the non-replacing
    /// file browser rename operation.
    fn publish_transfer<'a>(
        &'a self,
        from: &'a str,
        to: &'a str,
        overwrite: bool,
    ) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(publish_by_plain_rename(self, from, to, overwrite))
    }

    /// The whole contents of the file `path`, in memory (small files, e.g.
    /// remote editing): [`FsError::TooLarge`] past [`READ_FILE_LIMIT`].
    fn read_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<Vec<u8>>> {
        Box::pin(async move {
            let reader = self.open_read(path).await?;
            let mut data = Vec::new();
            reader
                .take(READ_FILE_LIMIT + 1)
                .read_to_end(&mut data)
                .await
                .map_err(|e| FsError::Protocol(format!("{path}: {e}")))?;
            if data.len() as u64 > READ_FILE_LIMIT {
                return Err(FsError::TooLarge {
                    path: path.to_owned(),
                    limit: READ_FILE_LIMIT,
                });
            }
            Ok(data)
        })
    }

    /// Replaces the contents of the file `path` with `data`, creating it if
    /// needed (an existing file keeps its permissions).
    fn write_file<'a>(&'a self, path: &'a str, data: &'a [u8]) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            let mut writer = self.create_write(path).await?;
            let io = |e: std::io::Error| FsError::Protocol(format!("{path}: {e}"));
            writer.write_all(data).await.map_err(io)?;
            writer.shutdown().await.map_err(io)
        })
    }
}

async fn publish_by_plain_rename(
    fs: &(impl RemoteFs + ?Sized),
    from: &str,
    to: &str,
    overwrite: bool,
) -> FsResult<()> {
    if overwrite {
        match fs.remove_file(to).await {
            Ok(()) | Err(FsError::NotFound(_)) => {}
            Err(error) => return Err(error),
        }
    }
    fs.rename(from, to).await
}

/// The directory the user asked for, as the File panel shows it: `""` and
/// `~` mean the home directory and `~/x` is under it; anything else is
/// resolved by the server. Fails with [`FsError::NotADirectory`] for a file.
pub async fn browse(fs: &dyn RemoteFs, path: &str) -> FsResult<Listing> {
    let path = match path.strip_prefix('~') {
        Some("") => fs.home().await?,
        Some(rest) if rest.starts_with('/') => format!("{}{rest}", fs.home().await?),
        _ if path.is_empty() => fs.home().await?,
        _ => path.to_owned(),
    };
    let path = fs.canonicalize(&path).await?;
    if fs.stat(&path).await?.kind != FileKind::Dir {
        return Err(FsError::NotADirectory(path));
    }
    let entries = fs.list_dir(&path).await?;
    Ok(Listing { path, entries })
}

/// How many entries [`remove_tree`] would delete at `path`: 1 for a file or
/// symlink, else the directory plus everything under it. Symlinks are not
/// followed.
pub async fn count_tree(fs: &dyn RemoteFs, path: &str) -> FsResult<u64> {
    Ok(walk(fs, path).await?.len() as u64)
}

async fn cancellable_scan<T>(
    mut cancelled: oneshot::Receiver<()>,
    scan: impl Future<Output = FsResult<T>>,
) -> FsResult<Option<T>> {
    tokio::select! {
        biased;
        _ = &mut cancelled => Ok(None),
        result = scan => result.map(Some),
    }
}

async fn sum_folder(fs: &(impl RemoteFs + ?Sized), path: &str) -> FsResult<u64> {
    // A trailing slash makes POSIX lstat resolve a directory symlink.
    let trimmed = path.trim_end_matches('/');
    let path = if trimmed.is_empty() { path } else { trimmed };
    if fs.lstat(path).await?.kind != FileKind::Dir {
        return Err(FsError::NotADirectory(path.to_owned()));
    }

    let mut bytes: u64 = 0;
    let mut pending = vec![path.to_owned()];
    while let Some(dir) = pending.pop() {
        for entry in fs.list_dir_no_follow(&dir).await? {
            match entry.kind {
                FileKind::Dir => pending.push(join(&dir, &entry.name)),
                FileKind::File => {
                    bytes = bytes.checked_add(entry.size).ok_or_else(|| {
                        FsError::Protocol("folder size exceeds 64-bit byte count".into())
                    })?;
                }
                FileKind::Symlink | FileKind::Other => {}
            }
        }
    }
    Ok(bytes)
}

/// Deletes `path`, and everything in it if it is a directory. Symlinks are
/// deleted, never followed. Stops at the first failure (entries deleted so
/// far stay deleted).
pub async fn remove_tree(fs: &dyn RemoteFs, path: &str) -> FsResult<()> {
    // Children come after their directory in the walk, so deleting in
    // reverse empties each directory before removing it.
    for (path, kind) in walk(fs, path).await?.into_iter().rev() {
        if kind == FileKind::Dir {
            fs.remove_dir(&path).await?;
        } else {
            fs.remove_file(&path).await?;
        }
    }
    Ok(())
}

/// Applies a File panel permissions edit. Entries that are symlinks are skipped.
/// Children are changed before their parent so removing search permission does
/// not prevent changing the rest of the tree.
pub async fn change_permissions(
    fs: &dyn RemoteFs,
    path: &str,
    change: PermissionChange,
) -> FsResult<()> {
    // A trailing slash makes POSIX lstat resolve a directory symlink.
    let trimmed = path.trim_end_matches('/');
    let path = if trimmed.is_empty() { path } else { trimmed };
    let root = fs.lstat(path).await?;
    if root.kind == FileKind::Symlink {
        return Ok(());
    }
    if change.uid.is_some() || change.gid.is_some() {
        fs.set_ownership(path, change.uid, change.gid).await?;
    }
    let Some(mode) = change.mode else {
        return Ok(());
    };
    if matches!(change.scope, PermissionScope::Entry) {
        return fs.set_permissions(path, mode).await;
    }
    if matches!(change.scope, PermissionScope::DirectoriesOnly) && mode & 0o111 == 0 {
        return Ok(());
    }
    for (path, kind) in walk(fs, path).await?.into_iter().rev() {
        if kind == FileKind::Symlink
            || (matches!(change.scope, PermissionScope::DirectoriesOnly) && kind != FileKind::Dir)
        {
            continue;
        }
        let stat = fs.lstat(&path).await?;
        let next = match (change.scope, stat.kind) {
            (_, FileKind::Symlink) => continue,
            (PermissionScope::DirectoriesOnly, FileKind::Dir) => {
                let current = stat
                    .permissions
                    .ok_or_else(|| FsError::Protocol(format!("{path}: missing permission bits")))?;
                let next = current | (mode & 0o111);
                if next == current {
                    continue;
                }
                next
            }
            (PermissionScope::DirectoriesOnly, _) => continue,
            _ => mode,
        };
        fs.set_permissions(&path, next).await?;
    }
    Ok(())
}

/// `path` and, for a directory, every entry under it (parents first),
/// without following symlinks.
async fn walk(fs: &dyn RemoteFs, path: &str) -> FsResult<Vec<(String, FileKind)>> {
    let mut found = vec![(path.to_owned(), fs.lstat(path).await?.kind)];
    let mut next = 0;
    while next < found.len() {
        let (dir, kind) = found[next].clone();
        next += 1;
        if kind != FileKind::Dir {
            continue;
        }
        for entry in fs.list_dir_no_follow(&dir).await? {
            found.push((join(&dir, &entry.name), entry.kind));
        }
    }
    Ok(found)
}

/// `name` inside the directory `dir`.
pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_adds_one_separator() {
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(join("/home/a", "b"), "/home/a/b");
    }
}
