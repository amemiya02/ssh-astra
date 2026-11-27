//! [`RemoteFs`] over SFTP subsystem channels on a Host's shared Connection.

use std::collections::VecDeque;
use std::future::Future;
use std::io::SeekFrom;
use std::sync::Arc;

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::fs::Metadata;
use russh_sftp::client::{RawSftpSession, SftpSession};
use russh_sftp::protocol::{File, FileAttributes, OpenFlags, Packet, StatusCode};
use tokio::io::AsyncSeekExt;
use tokio::sync::{oneshot, OnceCell};
use tokio::task::JoinSet;

use super::{
    cancellable_scan, join, publish_by_plain_rename, sum_folder, FileEntry, FileKind, FileReader,
    FileStat, FileWriter, FsError, FsResult, NameMatch, NameSearchMode, NameSearchResult, RemoteFs,
};
use crate::agent::{DirectoryRead, FILE_BYTE_LIMIT};
use crate::ssh::{BoxFuture, Connection};

/// Seconds to wait for each SFTP reply; slow links list big directories.
const REQUEST_TIMEOUT_SECS: u64 = 30;
const POSIX_RENAME: &str = "posix-rename@openssh.com";
const NAME_SEARCH_LIMIT: usize = 1_000;
const SFTP_READ_CHUNK: usize = 32 * 1024;

/// A Host's files over SFTP. Keeps its Connection open while it lives;
/// dropping it closes the SFTP channel (not the Connection, which Terminals
/// may still hold).
pub struct SftpFs {
    session: Arc<SftpSession>,
    rename_session: OnceCell<Option<RawSftpSession>>,
    connection: Arc<Connection>,
}

impl SftpFs {
    /// Lists one directory on the given Connection, stopping at the Agent access limits.
    pub async fn agent_list(
        connection: &Connection,
        path: &str,
        cancelled: oneshot::Receiver<()>,
    ) -> FsResult<Option<DirectoryRead>> {
        Self::scan(connection, cancelled, |stream| async move {
            let session = raw_session(connection, path, stream).await?;
            Self::list_bounded(&session, path).await
        })
        .await
    }

    async fn list_bounded(session: &RawSftpSession, path: &str) -> FsResult<DirectoryRead> {
        let handle = session
            .opendir(path)
            .await
            .map_err(|e| error(path, e))?
            .handle;
        let mut listing = DirectoryRead::default();
        'directory: while let Some(batch) = read_directory_batch(session, path, &handle).await? {
            for File {
                filename: name,
                attrs,
                ..
            } in batch
            {
                if matches!(name.as_str(), "." | "..") {
                    continue;
                }
                validate_name(&name)?;
                if !listing.push(entry(name, &attrs)) {
                    break 'directory;
                }
            }
        }
        session.close(handle).await.map_err(|e| error(path, e))?;
        Ok(listing)
    }

    /// Reads a regular file prefix with one extra byte to detect truncation.
    pub async fn agent_read(
        connection: &Connection,
        path: &str,
        cancelled: oneshot::Receiver<()>,
    ) -> FsResult<Option<Vec<u8>>> {
        Self::scan(connection, cancelled, |stream| async move {
            let session = raw_session(connection, path, stream).await?;
            Self::read_bounded(&session, path).await
        })
        .await
    }

    async fn read_bounded(session: &RawSftpSession, path: &str) -> FsResult<Vec<u8>> {
        let attributes = session.stat(path).await.map_err(|e| error(path, e))?;
        if kind(&attributes.attrs) != FileKind::File {
            return Err(FsError::Protocol("Expected a regular file".into()));
        }
        let handle = session
            .open(path, OpenFlags::READ, FileAttributes::empty())
            .await
            .map_err(|e| error(path, e))?
            .handle;
        let attributes = session.fstat(&handle).await.map_err(|e| error(path, e))?;
        if kind(&attributes.attrs) != FileKind::File {
            return Err(FsError::Protocol("Expected a regular file".into()));
        }
        let mut result = Vec::new();
        while result.len() <= FILE_BYTE_LIMIT {
            let bytes = (FILE_BYTE_LIMIT + 1 - result.len()).min(SFTP_READ_CHUNK);
            match session
                .read(&handle, result.len() as u64, bytes as u32)
                .await
            {
                Ok(data) if !data.data.is_empty() && data.data.len() <= bytes => {
                    result.extend(data.data)
                }
                Ok(_) => return Err(FsError::Protocol("Invalid SFTP read length".into())),
                Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => break,
                Err(err) => return Err(error(path, err)),
            }
        }
        session.close(handle).await.map_err(|e| error(path, e))?;
        Ok(result)
    }

    async fn scan<T, F>(
        connection: &Connection,
        mut cancelled: oneshot::Receiver<()>,
        run: impl FnOnce(russh::ChannelStream<russh::client::Msg>) -> F,
    ) -> FsResult<Option<T>>
    where
        F: Future<Output = FsResult<T>>,
    {
        if !matches!(
            cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ) {
            return Ok(None);
        }
        // Each scan owns its channel so cancellation also releases any directory
        // handle on the server. Wait for the SSH channel ID before closing.
        let channel = connection.open_session_channel().await;
        let channel = match channel {
            Ok(channel) => channel,
            Err(_)
                if !matches!(
                    cancelled.try_recv(),
                    Err(oneshot::error::TryRecvError::Empty)
                ) =>
            {
                return Ok(None)
            }
            Err(error) => return Err(connection.sftp_channel_error(error)),
        };
        let started = tokio::select! {
            biased;
            _ = &mut cancelled => {
                let _ = channel.close().await;
                return Ok(None);
            }
            result = Self::request_sftp(connection, &channel) => result,
        };
        if let Err(error) = started {
            let _ = channel.close().await;
            return Err(error);
        }
        cancellable_scan(cancelled, run(channel.into_stream())).await
    }

    pub(crate) async fn start(
        connection: Arc<Connection>,
        channel: russh::Channel<russh::client::Msg>,
    ) -> FsResult<Self> {
        Self::request_sftp(&connection, &channel).await?;
        Self::from_stream(connection, channel.into_stream()).await
    }

    async fn request_sftp(
        connection: &Connection,
        channel: &russh::Channel<russh::client::Msg>,
    ) -> FsResult<()> {
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| connection.sftp_channel_error(e))
    }

    async fn from_stream(
        connection: Arc<Connection>,
        stream: russh::ChannelStream<russh::client::Msg>,
    ) -> FsResult<Self> {
        let session = SftpSession::new(stream)
            .await
            .map_err(|e| connection_error(&connection, "", e))?;
        session.set_timeout(REQUEST_TIMEOUT_SECS);
        Ok(Self {
            session: Arc::new(session),
            rename_session: OnceCell::new(),
            connection,
        })
    }
}

impl SftpFs {
    /// Creates or verifies a private cache directory under the remote home.
    /// Refuses an existing symlink or a directory with broader permissions.
    pub async fn private_home_directory(&self, name: &str) -> FsResult<String> {
        if name.is_empty() || matches!(name, "." | "..") || name.contains(['/', '\\', '\0']) {
            return Err(FsError::InvalidName);
        }
        let path = join(&self.home().await?, name);
        let stat = match self.lstat(&path).await {
            Ok(stat) => stat,
            Err(FsError::NotFound(_)) => {
                let session = self.raw_session().await?;
                session.init().await.map_err(|e| self.error(&path, e))?;
                let attrs = FileAttributes {
                    permissions: Some(0o700),
                    ..Default::default()
                };
                if let Err(error) = session.mkdir(&path, attrs).await {
                    let error = self.unless_taken(&path, self.error(&path, error)).await;
                    if !matches!(error, FsError::AlreadyExists(_)) {
                        return Err(error);
                    }
                }
                self.lstat(&path).await?
            }
            Err(error) => return Err(error),
        };
        if stat.kind != FileKind::Dir || stat.permissions != Some(0o700) {
            return Err(FsError::PermissionDenied(path));
        }
        Ok(path)
    }

    async fn raw_session(&self) -> FsResult<RawSftpSession> {
        let channel = self
            .connection
            .open_session_channel()
            .await
            .map_err(|e| self.connection.sftp_channel_error(e))?;
        Self::request_sftp(&self.connection, &channel).await?;
        let session = RawSftpSession::new(channel.into_stream());
        session.set_timeout(REQUEST_TIMEOUT_SECS);
        Ok(session)
    }

    /// The high-level session does not expose extended requests. Open at
    /// most one extra channel on this Connection when an overwrite needs it.
    async fn rename_session(&self) -> FsResult<Option<RawSftpSession>> {
        let session = self.raw_session().await?;
        let version = session.init().await.map_err(|e| self.error("", e))?;
        match version.extensions.get(POSIX_RENAME).map(String::as_str) {
            Some("1") => Ok(Some(session)),
            Some(_) => Err(FsError::Protocol(format!(
                "unsupported version of {POSIX_RENAME}"
            ))),
            None => Ok(None),
        }
    }

    fn error(&self, path: &str, error: SftpError) -> FsError {
        connection_error(&self.connection, path, error)
    }

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
    fn transfer_namespace(&self) -> Option<&str> {
        Some(self.connection.file_namespace())
    }

    fn transfer_connection_lost(&self, error: &std::io::Error) -> bool {
        error
            .get_ref()
            .and_then(|inner| inner.downcast_ref::<SftpError>())
            .is_some_and(|error| connection_was_lost(&self.connection, error))
    }

    fn home(&self) -> BoxFuture<'_, FsResult<String>> {
        Box::pin(self.canonicalize("."))
    }

    fn canonicalize<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<String>> {
        Box::pin(async move {
            self.session
                .canonicalize(path)
                .await
                .map_err(|e| self.error(path, e))
        })
    }

    fn list_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<Vec<FileEntry>>> {
        Box::pin(async move {
            let mut entries = self.list_dir_no_follow(path).await?;
            let mut links = JoinSet::new();
            for (index, entry) in entries.iter().enumerate() {
                if entry.kind == FileKind::Symlink {
                    // Followed concurrently: a directory may hold many links.
                    let session = Arc::clone(&self.session);
                    let target = join(path, &entry.name);
                    links.spawn(async move { (index, session.metadata(target).await) });
                }
            }
            while let Some(done) = links.join_next().await {
                let Ok((index, target)) = done else { continue };
                // A dangling or unreadable link keeps `link_target: None`.
                entries[index].link_target = match target {
                    Ok(meta) => Some(kind(&meta)),
                    Err(e) if connection_was_lost(&self.connection, &e) => {
                        return Err(FsError::NotConnected);
                    }
                    Err(_) => None,
                };
            }
            Ok(entries)
        })
    }

    fn list_dir_no_follow<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<Vec<FileEntry>>> {
        Box::pin(async move {
            self.session
                .read_dir(path)
                .await
                .map_err(|e| self.error(path, e))?
                .map(|item| {
                    let name = item.file_name();
                    validate_name(&name)?;
                    Ok(entry(name, &item.metadata()))
                })
                .collect()
        })
    }

    fn folder_size<'a>(
        &'a self,
        path: &'a str,
        cancelled: oneshot::Receiver<()>,
    ) -> BoxFuture<'a, FsResult<Option<u64>>> {
        Box::pin(Self::scan(
            &self.connection,
            cancelled,
            move |stream| async move {
                let scan = Self::from_stream(Arc::clone(&self.connection), stream).await?;
                sum_folder(&scan, path).await
            },
        ))
    }

    fn search_names<'a>(
        &'a self,
        path: &'a str,
        query: &'a str,
        mode: NameSearchMode,
        cancelled: oneshot::Receiver<()>,
    ) -> BoxFuture<'a, FsResult<Option<NameSearchResult>>> {
        Box::pin(Self::scan(
            &self.connection,
            cancelled,
            move |stream| async move {
                let scan = raw_session(&self.connection, path, stream).await?;
                search_names(&scan, path, query, mode).await
            },
        ))
    }

    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileStat>> {
        Box::pin(async move {
            let meta = self
                .session
                .metadata(path)
                .await
                .map_err(|e| self.error(path, e))?;
            Ok(stat(&meta))
        })
    }

    fn open_read_at<'a>(
        &'a self,
        path: &'a str,
        offset: u64,
    ) -> BoxFuture<'a, FsResult<FileReader>> {
        Box::pin(async move {
            let mut file = self
                .session
                .open(path)
                .await
                .map_err(|e| self.error(path, e))?;
            if offset != 0 {
                file.seek(SeekFrom::Start(offset))
                    .await
                    .map_err(|e| seek_error(path, e))?;
            }
            Ok(Box::new(file) as FileReader)
        })
    }

    fn open_write_at<'a>(
        &'a self,
        path: &'a str,
        offset: u64,
    ) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move {
            let mut file = self
                .session
                .open_with_flags(path, OpenFlags::WRITE)
                .await
                .map_err(|e| self.error(path, e))?;
            file.seek(SeekFrom::Start(offset))
                .await
                .map_err(|e| seek_error(path, e))?;
            Ok(Box::new(file) as FileWriter)
        })
    }

    fn create_write<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move {
            // Truncates an existing file (and keeps its permissions).
            let file = self
                .session
                .create(path)
                .await
                .map_err(|e| self.error(path, e))?;
            Ok(Box::new(file) as FileWriter)
        })
    }

    fn create_new<'a>(
        &'a self,
        path: &'a str,
        private: bool,
    ) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move {
            let attrs = Metadata {
                permissions: private.then_some(0o600),
                ..Metadata::empty()
            };
            let flags = OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE;
            match self
                .session
                .open_with_flags_and_attributes(path, flags, attrs)
                .await
            {
                Ok(file) => Ok(Box::new(file) as FileWriter),
                Err(e) => Err(self.unless_taken(path, self.error(path, e)).await),
            }
        })
    }

    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileStat>> {
        Box::pin(async move {
            let meta = self
                .session
                .symlink_metadata(path)
                .await
                .map_err(|e| self.error(path, e))?;
            Ok(stat(&meta))
        })
    }

    fn create_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            match self.session.create_dir(path).await {
                Ok(()) => Ok(()),
                Err(e) => Err(self.unless_taken(path, self.error(path, e)).await),
            }
        })
    }

    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            // Plain SSH_FXP_RENAME, which OpenSSH refuses over an existing
            // target (unlike the posix-rename extension).
            match self.session.rename(from, to).await {
                Ok(()) => Ok(()),
                Err(e) => Err(self.unless_taken(to, self.error(from, e)).await),
            }
        })
    }

    fn publish_transfer<'a>(
        &'a self,
        from: &'a str,
        to: &'a str,
        overwrite: bool,
    ) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            if !overwrite {
                return self.rename(from, to).await;
            }
            let Some(session) = self
                .rename_session
                .get_or_try_init(|| self.rename_session())
                .await?
            else {
                return publish_by_plain_rename(self, from, to, true).await;
            };
            let payload = russh_sftp::ser::to_bytes(&(from, to))
                .map_err(|e| FsError::Protocol(e.to_string()))?;
            let response = session
                .extended(POSIX_RENAME, payload.to_vec())
                .await
                .map_err(|e| self.error(to, e))?;
            match response {
                Packet::Status(status) if status.status_code == StatusCode::Ok => Ok(()),
                Packet::Status(status) => Err(self.error(to, SftpError::Status(status))),
                _ => Err(error(to, SftpError::UnexpectedPacket)),
            }
        })
    }

    fn compress<'a>(
        &'a self,
        directory: &'a str,
        names: &'a [String],
        archive: &'a str,
    ) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(super::archive::compress(
            &self.connection,
            directory,
            names,
            archive,
        ))
    }

    fn extract_archive<'a>(
        &'a self,
        directory: &'a str,
        archive: &'a str,
    ) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(super::archive::extract(
            &self.connection,
            directory,
            archive,
        ))
    }

    fn remove_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            self.session
                .remove_file(path)
                .await
                .map_err(|e| self.error(path, e))
        })
    }

    fn remove_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            self.session
                .remove_dir(path)
                .await
                .map_err(|e| self.error(path, e))
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
                .map_err(|e| self.error(path, e))
        })
    }

    fn set_ownership<'a>(
        &'a self,
        path: &'a str,
        uid: Option<u32>,
        gid: Option<u32>,
    ) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            let current = self
                .session
                .symlink_metadata(path)
                .await
                .map_err(|e| self.error(path, e))?;
            if kind(&current) == FileKind::Symlink {
                return Ok(());
            }
            // SFTP v3 encodes UID and GID together, even if only one changes.
            let (Some(uid), Some(gid)) = (uid.or(current.uid), gid.or(current.gid)) else {
                return Err(FsError::OwnershipUnavailable(path.to_owned()));
            };
            if current.uid == Some(uid) && current.gid == Some(gid) {
                return Ok(());
            }
            self.session
                .set_metadata(
                    path,
                    Metadata {
                        uid: Some(uid),
                        gid: Some(gid),
                        ..Metadata::empty()
                    },
                )
                .await
                .map_err(|e| self.error(path, e))
        })
    }
}

async fn search_names(
    session: &RawSftpSession,
    path: &str,
    query: &str,
    mode: NameSearchMode,
) -> FsResult<NameSearchResult> {
    // A trailing slash makes lstat follow a symlink to a directory.
    let trimmed = path.trim_end_matches('/');
    let path = if trimmed.is_empty() { path } else { trimmed };
    require_directory(session, path).await?;
    let root = session
        .realpath(path)
        .await
        .map_err(|e| error(path, e))?
        .files
        .into_iter()
        .next()
        .ok_or_else(|| FsError::Protocol("SFTP returned no canonical path".into()))?
        .filename;
    let wildcard: Vec<char> = match mode {
        NameSearchMode::Substring => Vec::new(),
        NameSearchMode::Wildcard => query.chars().collect(),
    };

    let mut result = NameSearchResult::default();
    let mut pending = VecDeque::from([root.clone()]);
    while let Some(parent) = pending.pop_front() {
        let handle = match open_search_directory(session, &parent).await {
            Ok(handle) => handle,
            Err(
                FsError::PermissionDenied(_) | FsError::NotFound(_) | FsError::NotADirectory(_),
            ) if parent != root => {
                result.skipped_directories = true;
                continue;
            }
            Err(error) => return Err(error),
        };
        // Read one SFTP NAME packet at a time. The high-level read_dir would
        // fetch the whole directory before the visit limit could be enforced.
        loop {
            let batch = match read_directory_batch(session, &parent, &handle).await {
                Ok(Some(batch)) => batch,
                Ok(None) => break,
                Err(FsError::PermissionDenied(_) | FsError::NotFound(_)) if parent != root => {
                    result.skipped_directories = true;
                    break;
                }
                Err(error) => return Err(error),
            };
            for File {
                filename: name,
                attrs,
                ..
            } in batch
            {
                if matches!(name.as_str(), "." | "..") {
                    continue;
                }
                validate_name(&name)?;
                if kind(&attrs) == FileKind::Dir {
                    pending.push_back(join(&parent, &name));
                }
                let matched = match mode {
                    NameSearchMode::Substring => name.contains(query),
                    NameSearchMode::Wildcard => crate::wildcard::matches(&wildcard, &name),
                };
                if matched {
                    result.matches.push(NameMatch {
                        parent: parent.clone(),
                        name,
                    });
                }
                result.visited += 1;
                if result.visited == NAME_SEARCH_LIMIT {
                    result.limit_reached = true;
                    return Ok(result);
                }
            }
        }
        session.close(handle).await.map_err(|e| error(&parent, e))?;
    }
    Ok(result)
}

async fn require_directory(session: &RawSftpSession, path: &str) -> FsResult<()> {
    let attrs = session.lstat(path).await.map_err(|e| error(path, e))?.attrs;
    if kind(&attrs) != FileKind::Dir {
        return Err(FsError::NotADirectory(path.to_owned()));
    }
    Ok(())
}

async fn open_search_directory(session: &RawSftpSession, path: &str) -> FsResult<String> {
    require_directory(session, path).await?;
    Ok(session
        .opendir(path)
        .await
        .map_err(|e| error(path, e))?
        .handle)
}

async fn read_directory_batch(
    session: &RawSftpSession,
    path: &str,
    handle: &str,
) -> FsResult<Option<Vec<File>>> {
    match session.readdir(handle).await {
        Ok(batch) if !batch.files.is_empty() => Ok(Some(batch.files)),
        Ok(_) => Err(FsError::Protocol(
            "SFTP returned an empty directory packet".into(),
        )),
        Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => Ok(None),
        Err(err) => Err(error(path, err)),
    }
}

async fn raw_session(
    connection: &Connection,
    path: &str,
    stream: russh::ChannelStream<russh::client::Msg>,
) -> FsResult<RawSftpSession> {
    let session = RawSftpSession::new(stream);
    session.set_timeout(REQUEST_TIMEOUT_SECS);
    session
        .init()
        .await
        .map_err(|e| connection_error(connection, path, e))?;
    Ok(session)
}

fn validate_name(name: &str) -> FsResult<()> {
    if name.is_empty() || name.contains(['/', '\0']) {
        return Err(FsError::Protocol(
            "SFTP returned an invalid directory entry name".into(),
        ));
    }
    Ok(())
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
        uid: meta.uid,
        gid: meta.gid,
        link_target: None,
    }
}

fn connection_was_lost(connection: &Connection, error: &SftpError) -> bool {
    // A dropped SFTP channel alone can also produce I/O or response errors.
    // Check the SSH transport and preserve ordinary SFTP status failures.
    connection.is_closed()
        && match error {
            SftpError::IO(_) | SftpError::UnexpectedBehavior(_) | SftpError::Timeout => true,
            SftpError::Status(status) => {
                matches!(
                    status.status_code,
                    StatusCode::NoConnection | StatusCode::ConnectionLost
                )
            }
            _ => false,
        }
}

fn connection_error(connection: &Connection, path: &str, failure: SftpError) -> FsError {
    if connection_was_lost(connection, &failure) {
        FsError::NotConnected
    } else {
        error(path, failure)
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

fn seek_error(path: &str, e: std::io::Error) -> FsError {
    FsError::Io(format!("{path}: {e}"))
}
