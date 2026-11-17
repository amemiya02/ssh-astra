//! [`LiveHostFs`]: a Host's files over whatever session its live Connection
//! has at the time of each request.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use super::{FileEntry, FileReader, FileStat, FileWriter, FsResult, OpenRemote, RemoteFs};
use crate::ssh::BoxFuture;

/// A [`RemoteFs`] that asks `open` for a session on every request (the app
/// passes `ConnectionManager::live_sftp`). A remote edit outlives File panel
/// sessions and Connections, so after a reconnect its next save uploads
/// over the new Connection.
pub struct LiveHostFs {
    open: OpenRemote,
}

impl LiveHostFs {
    pub fn new(open: OpenRemote) -> Self {
        Self { open }
    }

    async fn fs(&self) -> FsResult<Arc<dyn RemoteFs>> {
        (self.open)().await
    }
}

impl RemoteFs for LiveHostFs {
    fn home(&self) -> BoxFuture<'_, FsResult<String>> {
        Box::pin(async move { self.fs().await?.home().await })
    }

    fn canonicalize<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<String>> {
        Box::pin(async move { self.fs().await?.canonicalize(path).await })
    }

    fn list_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<Vec<FileEntry>>> {
        Box::pin(async move { self.fs().await?.list_dir(path).await })
    }

    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileStat>> {
        Box::pin(async move { self.fs().await?.stat(path).await })
    }

    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileStat>> {
        Box::pin(async move { self.fs().await?.lstat(path).await })
    }

    fn create_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { self.fs().await?.create_dir(path).await })
    }

    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { self.fs().await?.rename(from, to).await })
    }

    fn remove_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { self.fs().await?.remove_file(path).await })
    }

    fn remove_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { self.fs().await?.remove_dir(path).await })
    }

    fn set_permissions<'a>(&'a self, path: &'a str, mode: u32) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { self.fs().await?.set_permissions(path, mode).await })
    }

    fn open_read<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileReader>> {
        Box::pin(async move {
            let fs = self.fs().await?;
            let file = fs.open_read(path).await?;
            Ok(Box::new(WithSession { file, _fs: fs }) as FileReader)
        })
    }

    fn create_write<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move {
            let fs = self.fs().await?;
            let file = fs.create_write(path).await?;
            Ok(Box::new(WithSession { file, _fs: fs }) as FileWriter)
        })
    }
}

/// An open file plus the session it was opened on, kept open for as long as
/// the file is.
struct WithSession<F> {
    file: F,
    _fs: Arc<dyn RemoteFs>,
}

impl AsyncRead for WithSession<FileReader> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.file).poll_read(cx, buf)
    }
}

impl AsyncWrite for WithSession<FileWriter> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.file).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.file).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.file).poll_shutdown(cx)
    }
}
