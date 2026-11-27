//! Write each transfer to a sibling file before publishing it at its final path.

use std::fmt::Write;
use std::path::PathBuf;
use std::sync::Arc;

use sha2::{Digest, Sha256};

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

    pub(super) async fn open_read(&self) -> FsResult<FileReader> {
        match self {
            Self::Local(fs, path) => fs.open_read(path).await,
            Self::Remote(fs, path) => fs.open_read(path).await,
        }
    }

    pub(super) async fn create_dir(&self) -> FsResult<()> {
        match self {
            Self::Local(fs, path) => fs.create_dir(path).await,
            Self::Remote(fs, path) => fs.create_dir(path).await,
        }
    }

    fn sibling(&self) -> FsResult<Self> {
        match self {
            Self::Local(fs, path) => {
                let name = path
                    .file_name()
                    .ok_or_else(|| FsError::Io(format!("{}: missing file name", path.display())))?;
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

pub(super) struct StagedWrite<'a> {
    target: &'a Side,
    temp: Option<Side>,
    original: Option<FileStat>,
}

impl<'a> StagedWrite<'a> {
    /// Returns the staging operation, its writer and the starting byte offset.
    pub(super) async fn begin(
        target: &'a Side,
        original: Option<FileStat>,
    ) -> FsResult<(Self, FileWriter, u64)> {
        let temp = target.sibling()?;
        let (temp, writer) = match temp.create_new(original.is_some()).await {
            Ok(writer) => (Some(temp), writer),
            Err(FsError::PermissionDenied(_)) if original.is_some() => {
                (None, target.create_write().await?)
            }
            Err(e) => return Err(e),
        };
        Ok((
            Self {
                target,
                temp,
                original,
            },
            writer,
            0,
        ))
    }

    pub(super) fn unprotected(&self) -> bool {
        self.temp.is_none()
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

    /// Removes the incomplete file. If the remote session died, try cleaning
    /// up over the current Connection, which may already have reconnected.
    pub(super) async fn discard(self, open: &OpenRemote) {
        let file = self.temp.as_ref().unwrap_or(self.target);
        let lost_session = matches!(
            file.remove().await,
            Err(FsError::NotConnected | FsError::TimedOut | FsError::Protocol(_))
        );
        if let (true, Some(Side::Remote(_, path))) = (lost_session, self.temp) {
            if let Ok(fs) = open().await {
                let _ = fs.remove_file(&path).await;
            }
        }
    }
}
