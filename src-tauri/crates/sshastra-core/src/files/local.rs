//! The user's own file system, as transfers see it: [`LocalFs`] is the seam,
//! [`DiskFs`] the real disk, and tests swap in an in-memory fake.

use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

use super::{FileEntry, FileKind, FileReader, FileStat, FileWriter, FsError, FsResult};
use crate::ssh::BoxFuture;

/// The local side of a transfer. Mirrors the streaming part of
/// [`RemoteFs`](super::RemoteFs) with native paths.
pub trait LocalFs: Send + Sync {
    /// The metadata of `path`, following symlinks.
    fn stat<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<FileStat>>;
    /// The entries of the directory `path`; a symlink is listed as such, with
    /// its target's kind in `link_target`.
    fn list_dir<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<Vec<FileEntry>>>;
    fn open_read<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<FileReader>>;
    /// Creates the file `path`, or empties it if it exists.
    fn create_write<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<FileWriter>>;
    /// Creates the directory `path`; its parent must exist.
    fn mkdir<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<()>>;
}

/// The real local disk.
#[derive(Debug, Default, Clone, Copy)]
pub struct DiskFs;

impl LocalFs for DiskFs {
    fn stat<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<FileStat>> {
        Box::pin(async move {
            let meta = tokio::fs::metadata(path)
                .await
                .map_err(|e| error(path, e))?;
            Ok(stat(&meta))
        })
    }

    fn list_dir<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<Vec<FileEntry>>> {
        Box::pin(async move {
            let mut dir = tokio::fs::read_dir(path)
                .await
                .map_err(|e| error(path, e))?;
            let mut entries = Vec::new();
            while let Some(item) = dir.next_entry().await.map_err(|e| error(path, e))? {
                let meta = item.metadata().await.map_err(|e| error(&item.path(), e))?;
                let FileStat {
                    kind,
                    size,
                    modified,
                    permissions,
                } = stat(&meta);
                let link_target = if kind == FileKind::Symlink {
                    tokio::fs::metadata(item.path())
                        .await
                        .ok()
                        .map(|m| stat(&m).kind)
                } else {
                    None
                };
                entries.push(FileEntry {
                    name: item.file_name().to_string_lossy().into_owned(),
                    kind,
                    size,
                    modified,
                    permissions,
                    link_target,
                });
            }
            Ok(entries)
        })
    }

    fn open_read<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<FileReader>> {
        Box::pin(async move {
            let file = tokio::fs::File::open(path)
                .await
                .map_err(|e| error(path, e))?;
            Ok(Box::new(file) as FileReader)
        })
    }

    fn create_write<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move {
            let file = tokio::fs::File::create(path)
                .await
                .map_err(|e| error(path, e))?;
            Ok(Box::new(file) as FileWriter)
        })
    }

    fn mkdir<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            tokio::fs::create_dir(path)
                .await
                .map_err(|e| error(path, e))
        })
    }
}

/// `std::fs::Metadata` from `symlink_metadata` reports links as such;
/// `metadata` follows them.
fn stat(meta: &std::fs::Metadata) -> FileStat {
    let file_type = meta.file_type();
    let kind = if file_type.is_symlink() {
        FileKind::Symlink
    } else if file_type.is_dir() {
        FileKind::Dir
    } else if file_type.is_file() {
        FileKind::File
    } else {
        FileKind::Other
    };
    FileStat {
        kind,
        size: if kind == FileKind::File {
            meta.len()
        } else {
            0
        },
        modified: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs()),
        permissions: permissions(meta),
    }
}

#[cfg(unix)]
fn permissions(meta: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(meta.permissions().mode() & 0o7777)
}

#[cfg(not(unix))]
fn permissions(_: &std::fs::Metadata) -> Option<u32> {
    None
}

fn error(path: &Path, e: io::Error) -> FsError {
    let path = path.display().to_string();
    match e.kind() {
        io::ErrorKind::NotFound => FsError::NotFound(path),
        io::ErrorKind::PermissionDenied => FsError::PermissionDenied(path),
        io::ErrorKind::NotADirectory => FsError::NotADirectory(path),
        _ => FsError::Io(format!("{path}: {e}")),
    }
}
