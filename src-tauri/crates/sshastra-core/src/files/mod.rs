//! Remote file systems: what the File panel browses (and, later, what file
//! operations, transfers and remote editing act on).
//!
//! [`RemoteFs`] is the seam: [`SftpFs`] implements it over a Host's
//! Connection (`Connection::open_sftp`), and tests may swap in an in-memory
//! fake. Paths are POSIX strings as the server sees them.

mod registry;
mod sftp;

pub use registry::{FsId, FsRegistry};
pub use sftp::SftpFs;

use serde::Serialize;

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

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FsError {
    /// The Host has no live Connection to browse over.
    #[error("not connected")]
    NotConnected,
    #[error("no such file or directory: {0}")]
    NotFound(String),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("not a directory: {0}")]
    NotADirectory(String),
    #[error("the server did not answer in time")]
    TimedOut,
    /// The SFTP session or its Connection failed, or the server refused
    /// for another reason.
    #[error("SFTP error: {0}")]
    Protocol(String),
}

pub type FsResult<T> = Result<T, FsError>;

/// A Host's file system as the File panel sees it. Object safe, so callers
/// hold an `Arc<dyn RemoteFs>` and tests can pass a fake.
pub trait RemoteFs: Send + Sync {
    /// The directory a new File panel opens in: the user's home directory.
    fn home(&self) -> BoxFuture<'_, FsResult<String>>;
    /// `path` made absolute (relative to the home directory), with `.`, `..`
    /// and symlinks resolved by the server.
    fn canonicalize<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<String>>;
    /// The entries of the directory `path`.
    fn list_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<Vec<FileEntry>>>;
    /// The metadata of `path`, following symlinks.
    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileStat>>;
    /// The whole contents of the file `path` (for small files, e.g. remote
    /// editing; transfers stream instead).
    fn read_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<Vec<u8>>>;
    /// Replaces the contents of the file `path` with `data`, creating it if
    /// needed (an existing file keeps its permissions).
    fn write_file<'a>(&'a self, path: &'a str, data: &'a [u8]) -> BoxFuture<'a, FsResult<()>>;
}

/// The directory the user asked for, as the File panel shows it: `""` and
/// `~` mean the home directory and `~/x` is under it; anything else is
/// resolved by the server. Fails with [`FsError::NotADirectory`] for a file.
pub async fn browse(fs: &dyn RemoteFs, path: &str) -> FsResult<Listing> {
    let path = path.trim();
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
