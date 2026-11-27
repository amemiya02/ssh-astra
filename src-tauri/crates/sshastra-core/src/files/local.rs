//! The user's own file system, as transfers see it: [`LocalFs`] is the seam,
//! [`DiskFs`] the real disk, and tests swap in an in-memory fake.

use std::io::{self, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tokio::io::AsyncSeekExt;

use super::{FileEntry, FileKind, FileReader, FileStat, FileWriter, FsError, FsResult, RemoteFs};
use crate::ssh::BoxFuture;

/// The local side of a transfer. Mirrors the streaming part of
/// [`RemoteFs`](super::RemoteFs) with native paths.
pub trait LocalFs: Send + Sync {
    /// The metadata of `path`, following symlinks.
    fn stat<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<FileStat>>;
    /// The metadata of the path itself, without following a symlink.
    fn lstat<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<FileStat>>;
    /// An absolute path with symlinks resolved.
    fn canonicalize<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<PathBuf>>;

    /// The entries of the directory `path`; a symlink is listed as such, with
    /// its target's kind in `link_target`.
    fn list_dir<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<Vec<FileEntry>>>;
    fn open_read<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<FileReader>> {
        self.open_read_at(path, 0)
    }
    fn open_read_at<'a>(
        &'a self,
        path: &'a Path,
        offset: u64,
    ) -> BoxFuture<'a, FsResult<FileReader>>;
    /// Opens an existing regular file for writing without truncating it.
    fn open_write_at<'a>(
        &'a self,
        path: &'a Path,
        offset: u64,
    ) -> BoxFuture<'a, FsResult<FileWriter>>;

    /// Creates the file `path`, or empties it if it exists.
    fn create_write<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<FileWriter>>;
    /// Exclusively creates a transfer's staging file, optionally with mode `0o600`.
    fn create_new<'a>(
        &'a self,
        path: &'a Path,
        private: bool,
    ) -> BoxFuture<'a, FsResult<FileWriter>>;
    /// Publishes a staged transfer with a single atomic rename.
    fn publish_transfer<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
        overwrite: bool,
    ) -> BoxFuture<'a, FsResult<()>>;
    fn set_permissions<'a>(&'a self, path: &'a Path, mode: u32) -> BoxFuture<'a, FsResult<()>>;
    /// Creates the directory `path`; its parent must exist.
    fn create_dir<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<()>>;
    /// Deletes a file or symlink without following it.
    fn remove_file<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<()>>;
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

    fn lstat<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<FileStat>> {
        Box::pin(async move {
            let meta = tokio::fs::symlink_metadata(path)
                .await
                .map_err(|e| error(path, e))?;
            Ok(stat(&meta))
        })
    }

    fn canonicalize<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<PathBuf>> {
        Box::pin(async move {
            tokio::fs::canonicalize(path)
                .await
                .map_err(|e| error(path, e))
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
                    name: item.file_name().into_string().map_err(|_| {
                        FsError::Io(format!(
                            "{}: filename is not valid Unicode",
                            item.path().display()
                        ))
                    })?,
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

    fn open_read_at<'a>(
        &'a self,
        path: &'a Path,
        offset: u64,
    ) -> BoxFuture<'a, FsResult<FileReader>> {
        Box::pin(async move {
            let mut file = tokio::fs::File::open(path)
                .await
                .map_err(|e| error(path, e))?;
            if offset != 0 {
                file.seek(SeekFrom::Start(offset))
                    .await
                    .map_err(|e| error(path, e))?;
            }
            Ok(Box::new(file) as FileReader)
        })
    }

    fn open_write_at<'a>(
        &'a self,
        path: &'a Path,
        offset: u64,
    ) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move {
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true);
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            options.custom_flags(
                (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
            );
            #[cfg(windows)]
            options.custom_flags(
                windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
            );
            let mut file = options.open(path).await.map_err(|e| error(path, e))?;
            let metadata = file.metadata().await.map_err(|e| error(path, e))?;
            if !metadata.is_file() {
                return Err(FsError::AlreadyExists(path.display().to_string()));
            }
            file.seek(SeekFrom::Start(offset))
                .await
                .map_err(|e| error(path, e))?;
            Ok(Box::new(file) as FileWriter)
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

    fn create_new<'a>(
        &'a self,
        path: &'a Path,
        private: bool,
    ) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move {
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            if private {
                options.mode(0o600);
            }
            #[cfg(not(unix))]
            let _ = private;
            let file = options.open(path).await.map_err(|e| error(path, e))?;
            Ok(Box::new(file) as FileWriter)
        })
    }

    fn publish_transfer<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
        overwrite: bool,
    ) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            if overwrite {
                tokio::fs::rename(from, to).await.map_err(|e| error(to, e))
            } else {
                rename_new(from.to_path_buf(), to.to_path_buf()).await
            }
        })
    }

    fn set_permissions<'a>(&'a self, path: &'a Path, mode: u32) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o7777))
                    .await
                    .map_err(|e| error(path, e))?;
            }
            #[cfg(not(unix))]
            let _ = (path, mode);
            Ok(())
        })
    }

    fn create_dir<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            tokio::fs::create_dir(path)
                .await
                .map_err(|e| error(path, e))
        })
    }

    fn remove_file<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            tokio::fs::remove_file(path)
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
        io::ErrorKind::AlreadyExists => FsError::AlreadyExists(path),
        _ => FsError::Io(format!("{path}: {e}")),
    }
}

/// Adapts the local disk to the file browser's operations. Paths returned to the
/// browser use forward slashes on Windows; native separators are restored at the disk.
pub struct DiskBrowser {
    home: PathBuf,
}

impl DiskBrowser {
    pub fn new(home: PathBuf) -> Self {
        Self { home }
    }

    /// Uses the platform's recursive removal, which does not traverse symlinks.
    pub async fn remove(&self, path: &str) -> FsResult<()> {
        let path = native_path(path);
        let meta = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|e| error(&path, e))?;
        if meta.is_dir() {
            tokio::fs::remove_dir_all(&path).await
        } else {
            return self.remove_file(&display_path(&path)?).await;
        }
        .map_err(|e| error(&path, e))
    }
}

fn native_path(path: &str) -> PathBuf {
    #[cfg(windows)]
    return PathBuf::from(path.replace('/', "\\"));
    #[cfg(not(windows))]
    return PathBuf::from(path);
}

fn display_path(path: &Path) -> FsResult<String> {
    let text = path
        .to_str()
        .ok_or_else(|| FsError::Io(format!("{}: path is not valid Unicode", path.display())))?;
    #[cfg(windows)]
    return Ok(dunce::simplified(path)
        .to_str()
        .unwrap_or(text)
        .replace('\\', "/"));
    #[cfg(not(windows))]
    return Ok(text.to_owned());
}

impl RemoteFs for DiskBrowser {
    fn home(&self) -> BoxFuture<'_, FsResult<String>> {
        Box::pin(async { display_path(&self.home) })
    }

    fn canonicalize<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<String>> {
        Box::pin(async move {
            let path = self.home.join(native_path(path));
            let resolved = tokio::fs::canonicalize(&path)
                .await
                .map_err(|e| error(&path, e))?;
            display_path(&resolved)
        })
    }

    fn list_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<Vec<FileEntry>>> {
        Box::pin(async move { DiskFs.list_dir(&native_path(path)).await })
    }

    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileStat>> {
        Box::pin(async move { DiskFs.stat(&native_path(path)).await })
    }

    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileStat>> {
        Box::pin(async move {
            let path = native_path(path);
            tokio::fs::symlink_metadata(&path)
                .await
                .map(|meta| stat(&meta))
                .map_err(|e| error(&path, e))
        })
    }

    fn create_new<'a>(
        &'a self,
        path: &'a str,
        private: bool,
    ) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move { DiskFs.create_new(&native_path(path), private).await })
    }

    fn publish_transfer<'a>(
        &'a self,
        from: &'a str,
        to: &'a str,
        overwrite: bool,
    ) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            DiskFs
                .publish_transfer(&native_path(from), &native_path(to), overwrite)
                .await
        })
    }

    fn create_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { DiskFs.create_dir(&native_path(path)).await })
    }

    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { rename_new(native_path(from), native_path(to)).await })
    }

    fn remove_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            let path = native_path(path);
            #[cfg(windows)]
            {
                use std::os::windows::fs::FileTypeExt;
                let meta = tokio::fs::symlink_metadata(&path)
                    .await
                    .map_err(|e| error(&path, e))?;
                if meta.file_type().is_symlink_dir() {
                    return tokio::fs::remove_dir(&path)
                        .await
                        .map_err(|e| error(&path, e));
                }
            }
            DiskFs.remove_file(&path).await
        })
    }

    fn remove_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            let path = native_path(path);
            tokio::fs::remove_dir(&path)
                .await
                .map_err(|e| error(&path, e))
        })
    }

    fn set_permissions<'a>(&'a self, path: &'a str, mode: u32) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let path = native_path(path);
                tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode))
                    .await
                    .map_err(|e| error(&path, e))
            }
            #[cfg(not(unix))]
            {
                let _ = (path, mode);
                Err(FsError::Io(
                    "POSIX permissions are unavailable on this platform".into(),
                ))
            }
        })
    }

    fn open_read_at<'a>(
        &'a self,
        path: &'a str,
        offset: u64,
    ) -> BoxFuture<'a, FsResult<FileReader>> {
        Box::pin(async move { DiskFs.open_read_at(&native_path(path), offset).await })
    }

    fn open_write_at<'a>(
        &'a self,
        path: &'a str,
        offset: u64,
    ) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move { DiskFs.open_write_at(&native_path(path), offset).await })
    }

    fn create_write<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move { DiskFs.create_write(&native_path(path)).await })
    }
}

async fn rename_new(from: PathBuf, to: PathBuf) -> FsResult<()> {
    tokio::task::spawn_blocking(move || {
        rename_without_replace(&from, &to).map_err(|e| error(&to, e))
    })
    .await
    .map_err(|e| FsError::Io(e.to_string()))?
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn rename_without_replace(from: &Path, to: &Path) -> io::Result<()> {
    use rustix::fs::{renameat_with, RenameFlags, CWD};
    Ok(renameat_with(CWD, from, CWD, to, RenameFlags::NOREPLACE)?)
}

#[cfg(windows)]
fn rename_without_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let wide = |path: &Path| -> io::Result<Vec<u16>> {
        let mut path: Vec<_> = path.as_os_str().encode_wide().collect();
        if path.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path contains a null character",
            ));
        }
        path.push(0);
        Ok(path)
    };
    let (from, to) = (wide(from)?, wide(to)?);
    // Valid, null-terminated strings. No replace flag, so an existing target is safe.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn rename_without_replace(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "rename without replacement is unavailable",
    ))
}
