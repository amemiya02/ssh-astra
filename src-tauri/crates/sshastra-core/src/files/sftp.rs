//! [`RemoteFs`] over SFTP: one `sftp` subsystem channel on a Host's shared
//! Connection.

use std::sync::Arc;

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::fs::Metadata;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::StatusCode;
use tokio::task::JoinSet;

use super::{
    join, FileEntry, FileKind, FileReader, FileStat, FileWriter, FsError, FsResult, RemoteFs,
};
use crate::ssh::{BoxFuture, Connection};

/// Seconds to wait for each SFTP reply; slow links list big directories.
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// A Host's files over SFTP. Keeps its Connection open while it lives;
/// dropping it closes the SFTP channel (not the Connection, which Terminals
/// may still hold).
pub struct SftpFs {
    session: Arc<SftpSession>,
    _connection: Arc<Connection>,
}

impl SftpFs {
    pub(crate) async fn start(
        connection: Arc<Connection>,
        channel: russh::Channel<russh::client::Msg>,
    ) -> FsResult<Self> {
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| FsError::Protocol(e.to_string()))?;
        let session = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| error("", e))?;
        session.set_timeout(REQUEST_TIMEOUT_SECS);
        Ok(Self {
            session: Arc::new(session),
            _connection: connection,
        })
    }
}

impl SftpFs {
    /// OpenSSH answers a bare "failure" when the target of a mkdir or rename
    /// exists; tell that case apart so the user sees why.
    async fn unless_taken(&self, target: &str, err: FsError) -> FsError {
        if !matches!(err, FsError::Protocol(_)) {
            return err;
        }
        match self.session.symlink_metadata(target).await {
            Ok(_) => FsError::AlreadyExists(target.to_owned()),
            Err(_) => err,
        }
    }
}

impl Drop for SftpFs {
    fn drop(&mut self) {
        // Closes the channel even while a spawned symlink lookup still holds
        // a clone of the session.
        let session = Arc::clone(&self.session);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = session.close().await;
            });
        }
    }
}

impl RemoteFs for SftpFs {
    fn home(&self) -> BoxFuture<'_, FsResult<String>> {
        Box::pin(self.canonicalize("."))
    }

    fn canonicalize<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<String>> {
        Box::pin(async move {
            self.session
                .canonicalize(path)
                .await
                .map_err(|e| error(path, e))
        })
    }

    fn list_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<Vec<FileEntry>>> {
        Box::pin(async move {
            let dir = self
                .session
                .read_dir(path)
                .await
                .map_err(|e| error(path, e))?;
            let mut entries = Vec::new();
            let mut links = JoinSet::new();
            for item in dir {
                let name = item.file_name();
                if name.is_empty() || name.contains(['/', '\0']) {
                    return Err(FsError::Protocol(
                        "SFTP returned an invalid directory entry name".into(),
                    ));
                }
                let entry = entry(name, &item.metadata());
                if entry.kind == FileKind::Symlink {
                    // Followed concurrently: a directory may hold many links.
                    let session = Arc::clone(&self.session);
                    let target = join(path, &entry.name);
                    let index = entries.len();
                    links.spawn(async move { (index, session.metadata(target).await) });
                }
                entries.push(entry);
            }
            while let Some(done) = links.join_next().await {
                let Ok((index, target)) = done else { continue };
                // A dangling or unreadable link keeps `link_target: None`.
                entries[index].link_target = target.ok().map(|m| kind(&m));
            }
            Ok(entries)
        })
    }

    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileStat>> {
        Box::pin(async move {
            let meta = self
                .session
                .metadata(path)
                .await
                .map_err(|e| error(path, e))?;
            Ok(stat(&meta))
        })
    }

    fn open_read<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileReader>> {
        Box::pin(async move {
            let file = self.session.open(path).await.map_err(|e| error(path, e))?;
            Ok(Box::new(file) as FileReader)
        })
    }

    fn create_write<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move {
            // Truncates an existing file (and keeps its permissions).
            let file = self
                .session
                .create(path)
                .await
                .map_err(|e| error(path, e))?;
            Ok(Box::new(file) as FileWriter)
        })
    }

    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileStat>> {
        Box::pin(async move {
            let meta = self
                .session
                .symlink_metadata(path)
                .await
                .map_err(|e| error(path, e))?;
            Ok(stat(&meta))
        })
    }

    fn create_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            match self.session.create_dir(path).await {
                Ok(()) => Ok(()),
                Err(e) => Err(self.unless_taken(path, error(path, e)).await),
            }
        })
    }

    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            // Plain SSH_FXP_RENAME, which OpenSSH refuses over an existing
            // target (unlike the posix-rename extension).
            match self.session.rename(from, to).await {
                Ok(()) => Ok(()),
                Err(e) => Err(self.unless_taken(to, error(from, e)).await),
            }
        })
    }

    fn remove_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            self.session
                .remove_file(path)
                .await
                .map_err(|e| error(path, e))
        })
    }

    fn remove_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            self.session
                .remove_dir(path)
                .await
                .map_err(|e| error(path, e))
        })
    }

    fn set_permissions<'a>(&'a self, path: &'a str, mode: u32) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            let attrs = Metadata {
                permissions: Some(mode & 0o7777),
                ..Metadata::empty()
            };
            self.session
                .set_metadata(path, attrs)
                .await
                .map_err(|e| error(path, e))
        })
    }
}

fn kind(meta: &Metadata) -> FileKind {
    // Not `Metadata::is_*`: they test bits with `contains`, and a symlink's
    // type bits contain a regular file's.
    match meta.permissions.unwrap_or(0) & 0o170_000 {
        0o040_000 => FileKind::Dir,
        0o100_000 => FileKind::File,
        0o120_000 => FileKind::Symlink,
        _ => FileKind::Other,
    }
}

fn stat(meta: &Metadata) -> FileStat {
    FileStat {
        kind: kind(meta),
        size: meta.size.unwrap_or(0),
        modified: meta.mtime.map(u64::from),
        permissions: meta.permissions.map(|mode| mode & 0o7777),
    }
}

fn entry(name: String, meta: &Metadata) -> FileEntry {
    let FileStat {
        kind,
        size,
        modified,
        permissions,
    } = stat(meta);
    FileEntry {
        name,
        kind,
        size,
        modified,
        permissions,
        link_target: None,
    }
}

fn error(path: &str, e: SftpError) -> FsError {
    match e {
        SftpError::Status(status) => match status.status_code {
            StatusCode::NoSuchFile => FsError::NotFound(path.to_owned()),
            StatusCode::PermissionDenied => FsError::PermissionDenied(path.to_owned()),
            _ => FsError::Protocol(format!("{path}: {}", status.error_message)),
        },
        SftpError::Timeout => FsError::TimedOut,
        other => FsError::Protocol(other.to_string()),
    }
}
