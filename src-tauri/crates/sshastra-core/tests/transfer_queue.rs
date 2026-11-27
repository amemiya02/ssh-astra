//! TransferQueue against in-memory local and remote file systems.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use sshastra_core::files::{
    ConflictAnswer, FileEntry, FileKind, FileReader, FileStat, FileWriter, FsError, FsResult,
    LocalFs, OpenRemote, RemoteFs, RemoteTransfer, Transfer, TransferDirection, TransferHost,
    TransferQueue, TransferState,
};
use sshastra_core::hosts::HostId;
use sshastra_core::ssh::BoxFuture;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::{futures::OwnedNotified, Notify, Semaphore};

// ---------------------------------------------------------------------------
// An in-memory file system, usable as either side.

#[derive(Debug, Clone, PartialEq, Eq)]
enum Node {
    Dir,
    File(Vec<u8>, u32),
}

#[derive(Default)]
struct MemoryFs {
    nodes: Arc<Mutex<BTreeMap<String, Node>>>,
    /// When set, every read waits for a permit before it starts.
    gate: Option<Arc<Semaphore>>,
    reading: Arc<AtomicUsize>,
    max_reading: Arc<AtomicUsize>,
    read_bytes: Arc<AtomicUsize>,
    written_bytes: Arc<AtomicUsize>,
    fail_next_read: Mutex<HashSet<String>>,
    /// Reads of these files stop after their first chunk.
    break_reads: Mutex<HashMap<String, Break>>,
    /// Fail writes once this many bytes have reached a file.
    fail_write_after: Mutex<Option<usize>>,
    deny_creation: Mutex<HashSet<String>>,
    stage_open_gate: Mutex<Option<Arc<Semaphore>>>,
    stage_open_started: Notify,
    pause_after_first: Mutex<Option<Arc<Notify>>>,
}

/// How a read stops partway through a file.
#[derive(Debug, Clone, Copy)]
enum Break {
    /// Waits forever (until the transfer is cancelled).
    Stall,
    Fail,
}

impl MemoryFs {
    fn new() -> Arc<Self> {
        Arc::new(Self::empty())
    }

    fn empty() -> Self {
        let fs = Self::default();
        fs.dir("/");
        fs
    }

    fn gated() -> (Arc<Self>, Arc<Semaphore>) {
        let gate = Arc::new(Semaphore::new(0));
        let fs = Self {
            gate: Some(Arc::clone(&gate)),
            ..Self::empty()
        };
        (Arc::new(fs), gate)
    }

    fn dir(&self, path: &str) {
        self.nodes
            .lock()
            .unwrap()
            .insert(path.to_owned(), Node::Dir);
    }

    fn file(&self, path: &str, data: impl Into<Vec<u8>>) {
        self.nodes
            .lock()
            .unwrap()
            .insert(path.to_owned(), Node::File(data.into(), 0o644));
    }

    fn read(&self, path: &str) -> Option<Vec<u8>> {
        match self.nodes.lock().unwrap().get(path)? {
            Node::File(data, _) => Some(data.clone()),
            Node::Dir => None,
        }
    }

    /// Every path under `root` (excluding it), relative, with its node.
    fn tree(&self, root: &str) -> Vec<(String, Node)> {
        let prefix = format!("{root}/");
        self.nodes
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(p, n)| Some((p.strip_prefix(&prefix)?.to_owned(), n.clone())))
            .collect()
    }

    fn break_reads(&self, path: &str, how: Break) {
        self.break_reads
            .lock()
            .unwrap()
            .insert(path.to_owned(), how);
    }

    fn fail_next_read(&self, path: &str) {
        self.fail_next_read.lock().unwrap().insert(path.to_owned());
    }

    fn stat_path(&self, path: &str) -> FsResult<FileStat> {
        let nodes = self.nodes.lock().unwrap();
        let node = nodes
            .get(path)
            .ok_or_else(|| FsError::NotFound(path.to_owned()))?;
        Ok(stat(node))
    }

    fn list_path(&self, path: &str) -> FsResult<Vec<FileEntry>> {
        let nodes = self.nodes.lock().unwrap();
        match nodes.get(path) {
            None => return Err(FsError::NotFound(path.to_owned())),
            Some(Node::File(..)) => return Err(FsError::NotADirectory(path.to_owned())),
            Some(Node::Dir) => {}
        }
        let prefix = if path == "/" {
            "/".to_owned()
        } else {
            format!("{path}/")
        };
        Ok(nodes
            .iter()
            .filter_map(|(p, node)| {
                let name = p.strip_prefix(&prefix)?;
                (!name.is_empty() && !name.contains('/')).then(|| {
                    let s = stat(node);
                    FileEntry {
                        name: name.to_owned(),
                        kind: s.kind,
                        size: s.size,
                        modified: None,
                        permissions: s.permissions,
                        uid: None,
                        gid: None,
                        link_target: None,
                    }
                })
            })
            .collect())
    }

    async fn open_read_path(&self, path: &str, offset: u64) -> FsResult<FileReader> {
        if self.fail_next_read.lock().unwrap().remove(path) {
            return Err(FsError::Protocol("read failed".into()));
        }
        let data = match self.nodes.lock().unwrap().get(path) {
            Some(Node::File(data, _)) => data.clone(),
            Some(Node::Dir) => return Err(FsError::Protocol("is a directory".into())),
            None => return Err(FsError::NotFound(path.to_owned())),
        };
        let now = self.reading.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_reading.fetch_max(now, Ordering::SeqCst);
        let guard = Reading(Arc::clone(&self.reading));
        if let Some(gate) = &self.gate {
            gate.acquire().await.unwrap().forget();
        }
        let mut data = io::Cursor::new(data);
        data.set_position(offset);
        Ok(Box::new(MemoryReader {
            data,
            start: offset,
            bytes: self.read_bytes.clone(),
            stop: self.break_reads.lock().unwrap().get(path).copied(),
            pause: self
                .pause_after_first
                .lock()
                .unwrap()
                .as_ref()
                .map(|gate| Box::pin(gate.clone().notified_owned())),
            _guard: guard,
        }))
    }

    fn create_write_path(&self, path: &str, exclusive: bool) -> FsResult<FileWriter> {
        let mut nodes = self.nodes.lock().unwrap();
        let parent = path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        let parent = if parent.is_empty() { "/" } else { parent };
        if nodes.get(parent) != Some(&Node::Dir) {
            return Err(FsError::NotFound(path.to_owned()));
        }
        if exclusive && nodes.contains_key(path) {
            return Err(FsError::AlreadyExists(path.to_owned()));
        }
        let mode = match nodes.get(path) {
            Some(Node::File(_, mode)) => *mode,
            None if self.deny_creation.lock().unwrap().contains(parent) => {
                return Err(FsError::PermissionDenied(path.to_owned()));
            }
            _ => 0o644,
        };
        nodes.insert(path.to_owned(), Node::File(Vec::new(), mode));
        Ok(self.writer(path, 0))
    }

    fn open_write_path(&self, path: &str, offset: u64) -> FsResult<FileWriter> {
        let nodes = self.nodes.lock().unwrap();
        if !matches!(nodes.get(path), Some(Node::File(..))) {
            return Err(FsError::NotFound(path.into()));
        }
        Ok(self.writer(path, offset as usize))
    }

    fn writer(&self, path: &str, offset: usize) -> FileWriter {
        Box::new(MemoryWriter {
            nodes: Arc::clone(&self.nodes),
            path: path.to_owned(),
            offset,
            bytes: self.written_bytes.clone(),
            limit: *self.fail_write_after.lock().unwrap(),
        })
    }

    fn set_mode(&self, path: &str, mode: u32) -> FsResult<()> {
        let mut nodes = self.nodes.lock().unwrap();
        match nodes.get_mut(path) {
            Some(Node::File(_, current)) => {
                *current = mode;
                Ok(())
            }
            _ => Err(FsError::NotFound(path.to_owned())),
        }
    }

    fn create_dir_path(&self, path: &str) -> FsResult<()> {
        let mut nodes = self.nodes.lock().unwrap();
        if nodes.contains_key(path) {
            return Err(FsError::AlreadyExists(path.to_owned()));
        }
        nodes.insert(path.to_owned(), Node::Dir);
        Ok(())
    }

    fn remove_path(&self, path: &str, dir: bool) -> FsResult<()> {
        let mut nodes = self.nodes.lock().unwrap();
        match nodes.get(path) {
            None => return Err(FsError::NotFound(path.to_owned())),
            Some(Node::Dir) if !dir => return Err(FsError::Protocol("is a directory".into())),
            Some(Node::File(..)) if dir => return Err(FsError::NotADirectory(path.to_owned())),
            _ => {}
        }
        let parent = path
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("");
        let parent = if parent.is_empty() { "/" } else { parent };
        if self.deny_creation.lock().unwrap().contains(parent) {
            return Err(FsError::PermissionDenied(path.to_owned()));
        }
        let prefix = format!("{path}/");
        if dir && nodes.keys().any(|p| p.starts_with(&prefix)) {
            return Err(FsError::Protocol("directory not empty".into()));
        }
        nodes.remove(path);
        Ok(())
    }

    fn rename_path(&self, from: &str, to: &str, overwrite: bool) -> FsResult<()> {
        let mut nodes = self.nodes.lock().unwrap();
        let parent = to.rsplit_once('/').map(|(parent, _)| parent).unwrap_or("");
        let parent = if parent.is_empty() { "/" } else { parent };
        if self.deny_creation.lock().unwrap().contains(parent) {
            return Err(FsError::PermissionDenied(to.to_owned()));
        }
        if !overwrite && nodes.contains_key(to) {
            return Err(FsError::AlreadyExists(to.to_owned()));
        }
        let moved: Vec<String> = nodes
            .keys()
            .filter(|p| *p == from || p.starts_with(&format!("{from}/")))
            .cloned()
            .collect();
        if moved.is_empty() {
            return Err(FsError::NotFound(from.to_owned()));
        }
        for old in moved {
            let node = nodes.remove(&old).unwrap();
            nodes.insert(format!("{to}{}", &old[from.len()..]), node);
        }
        Ok(())
    }
}

fn stat(node: &Node) -> FileStat {
    let (kind, size, permissions) = match node {
        Node::Dir => (FileKind::Dir, 0, 0o755),
        Node::File(data, mode) => (FileKind::File, data.len() as u64, *mode),
    };
    FileStat {
        kind,
        size,
        modified: None,
        permissions: Some(permissions),
    }
}

struct Reading(Arc<AtomicUsize>);

impl Drop for Reading {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct MemoryReader {
    data: io::Cursor<Vec<u8>>,
    start: u64,
    bytes: Arc<AtomicUsize>,
    stop: Option<Break>,
    pause: Option<Pin<Box<OwnedNotified>>>,
    _guard: Reading,
}

impl AsyncRead for MemoryReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.data.position() > self.start {
            if let Some(pause) = &mut self.pause {
                if pause.as_mut().poll(cx).is_pending() {
                    return Poll::Pending;
                }
                self.pause = None;
            }
        }
        match self.stop {
            Some(Break::Stall) if self.data.position() > self.start => return Poll::Pending,
            Some(Break::Fail) if self.data.position() > self.start => {
                return Poll::Ready(Err(io::Error::other("connection lost")));
            }
            _ => {}
        }
        // A small chunk at a time, like a network read.
        let mut chunk = [0u8; 4096];
        let n = std::io::Read::read(&mut self.data, &mut chunk[..buf.remaining().min(4096)])?;
        self.bytes.fetch_add(n, Ordering::SeqCst);
        buf.put_slice(&chunk[..n]);
        Poll::Ready(Ok(()))
    }
}

struct MemoryWriter {
    limit: Option<usize>,
    nodes: Arc<Mutex<BTreeMap<String, Node>>>,
    path: String,
    offset: usize,
    bytes: Arc<AtomicUsize>,
}

impl AsyncWrite for MemoryWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let mut nodes = self.nodes.lock().unwrap();
        let Some(Node::File(data, _)) = nodes.get_mut(&self.path) else {
            return Poll::Ready(Err(io::Error::other("file disappeared")));
        };
        let offset = self.offset;
        let len = self.limit.map_or(buf.len(), |limit| {
            buf.len().min(limit.saturating_sub(offset))
        });
        if len == 0 && !buf.is_empty() {
            return Poll::Ready(Err(io::Error::other("write failed")));
        }
        let end = offset + len;
        if data.len() < end {
            data.resize(end, 0);
        }
        data[offset..end].copy_from_slice(&buf[..len]);
        drop(nodes);
        self.offset = end;
        self.bytes.fetch_add(len, Ordering::SeqCst);
        Poll::Ready(Ok(len))
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

fn local_str(path: &Path) -> String {
    path.to_str().unwrap().replace('\\', "/")
}

impl LocalFs for MemoryFs {
    fn stat<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<FileStat>> {
        Box::pin(async move { self.stat_path(&local_str(path)) })
    }
    fn lstat<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<FileStat>> {
        LocalFs::stat(self, path)
    }
    fn canonicalize<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<PathBuf>> {
        Box::pin(async move { Ok(path.to_path_buf()) })
    }
    fn list_dir<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<Vec<FileEntry>>> {
        Box::pin(async move { self.list_path(&local_str(path)) })
    }
    fn open_read_at<'a>(
        &'a self,
        path: &'a Path,
        offset: u64,
    ) -> BoxFuture<'a, FsResult<FileReader>> {
        Box::pin(async move { self.open_read_path(&local_str(path), offset).await })
    }
    fn open_write_at<'a>(
        &'a self,
        path: &'a Path,
        offset: u64,
    ) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move { self.open_write_path(&local_str(path), offset) })
    }
    fn create_write<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move { self.create_write_path(&local_str(path), false) })
    }
    fn create_new<'a>(&'a self, path: &'a Path, _: bool) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move { self.create_write_path(&local_str(path), true) })
    }
    fn publish_transfer<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
        overwrite: bool,
    ) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { self.rename_path(&local_str(from), &local_str(to), overwrite) })
    }
    fn set_permissions<'a>(&'a self, path: &'a Path, mode: u32) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { self.set_mode(&local_str(path), mode) })
    }
    fn create_dir<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { self.create_dir_path(&local_str(path)) })
    }
    fn remove_file<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { self.remove_path(&local_str(path), false) })
    }
}

impl RemoteFs for MemoryFs {
    fn home(&self) -> BoxFuture<'_, FsResult<String>> {
        Box::pin(async { Ok("/".to_owned()) })
    }
    fn canonicalize<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<String>> {
        Box::pin(async move { Ok(path.to_owned()) })
    }
    fn list_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<Vec<FileEntry>>> {
        Box::pin(async move { self.list_path(path) })
    }
    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileStat>> {
        Box::pin(async move { self.stat_path(path) })
    }
    fn open_read_at<'a>(
        &'a self,
        path: &'a str,
        offset: u64,
    ) -> BoxFuture<'a, FsResult<FileReader>> {
        Box::pin(self.open_read_path(path, offset))
    }
    fn open_write_at<'a>(
        &'a self,
        path: &'a str,
        offset: u64,
    ) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move { self.open_write_path(path, offset) })
    }
    fn create_write<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move { self.create_write_path(path, false) })
    }
    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileStat>> {
        Box::pin(async move { self.stat_path(path) })
    }
    fn create_new<'a>(&'a self, path: &'a str, _: bool) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move {
            let gate = self.stage_open_gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                self.stage_open_started.notify_one();
                gate.acquire().await.unwrap().forget();
            }
            self.create_write_path(path, true)
        })
    }
    fn create_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { self.create_dir_path(path) })
    }
    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { self.rename_path(from, to, false) })
    }
    fn remove_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { self.remove_path(path, false) })
    }
    fn remove_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { self.remove_path(path, true) })
    }
    fn set_permissions<'a>(&'a self, path: &'a str, mode: u32) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { self.set_mode(path, mode) })
    }
}

// ---------------------------------------------------------------------------
// Harness.

struct Harness {
    queue: TransferQueue,
    local: Arc<MemoryFs>,
    remote: Arc<MemoryFs>,
    events: Arc<Mutex<Vec<Transfer>>>,
}

impl Harness {
    fn new() -> Self {
        Self::with(MemoryFs::new(), MemoryFs::new())
    }

    fn with(local: Arc<MemoryFs>, remote: Arc<MemoryFs>) -> Self {
        let events: Arc<Mutex<Vec<Transfer>>> = Arc::default();
        let sink = Arc::clone(&events);
        let queue = TransferQueue::new(local.clone(), move |t: &Transfer| {
            sink.lock().unwrap().push(t.clone());
        });
        Self {
            queue,
            local,
            remote,
            events,
        }
    }

    fn opener(&self) -> OpenRemote {
        let remote = Arc::clone(&self.remote);
        Arc::new(move || {
            let remote: Arc<dyn RemoteFs> = remote.clone();
            Box::pin(async move { Ok(remote) })
        })
    }

    fn upload(&self, local: &str, remote_dir: &str) -> sshastra_core::files::TransferId {
        self.queue
            .upload(self.opener(), PathBuf::from(local), remote_dir.to_owned())
    }

    fn download(&self, remote: &str, local_dir: &str) -> sshastra_core::files::TransferId {
        self.queue
            .download(self.opener(), remote.to_owned(), PathBuf::from(local_dir))
    }

    fn transfer(&self, id: sshastra_core::files::TransferId) -> Transfer {
        self.queue
            .list()
            .into_iter()
            .find(|t| t.id == id)
            .expect("transfer is listed")
    }

    /// Waits until `done` holds for the queue's transfers.
    async fn until(&self, what: &str, done: impl Fn(&[Transfer]) -> bool) {
        let wait = async {
            loop {
                if done(&self.queue.list()) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        };
        if tokio::time::timeout(Duration::from_secs(5), wait)
            .await
            .is_err()
        {
            panic!("timed out waiting for {what}: {:#?}", self.queue.list());
        }
    }

    async fn until_state(&self, id: sshastra_core::files::TransferId, state: TransferState) {
        let what = format!("{state:?}");
        self.until(&what, |all| {
            all.iter().any(|t| t.id == id && t.state == state)
        })
        .await;
    }

    async fn until_settled(&self) {
        self.until("every transfer to finish", |all| {
            all.iter().all(|t| {
                matches!(
                    t.state,
                    TransferState::Done | TransferState::Failed { .. } | TransferState::Cancelled
                )
            })
        })
        .await;
    }

    fn events_for(&self, id: sshastra_core::files::TransferId) -> Vec<Transfer> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|t| t.id == id)
            .cloned()
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Tests.

fn remote_endpoint(fs: &Arc<MemoryFs>, id: &str, name: &str) -> RemoteTransfer {
    let fs = fs.clone();
    RemoteTransfer {
        host: TransferHost {
            id: HostId::from(id.to_owned()),
            name: name.to_owned(),
            temporary: false,
        },
        open: Arc::new(move || {
            let fs: Arc<dyn RemoteFs> = fs.clone();
            Box::pin(async move { Ok(fs) })
        }),
    }
}

#[tokio::test]
async fn copying_between_hosts_preserves_the_nested_tree_and_identifies_both_hosts() {
    let h = Harness::new();
    let source = MemoryFs::new();
    source.dir("/site");
    source.file("/site/index.html", "<h1>");
    source.dir("/site/assets");
    source.dir("/site/assets/empty");
    source.file("/site/assets/app.js", "js");
    h.remote.dir("/incoming");

    let id = h.queue.copy_remote(
        remote_endpoint(&source, "source", "Web"),
        "/site".into(),
        remote_endpoint(&h.remote, "target", "Backup"),
        "/incoming".into(),
    );
    h.until_state(id, TransferState::Done).await;

    assert_eq!(h.remote.tree("/incoming/site"), source.tree("/site"));
    assert_eq!(h.local.written_bytes.load(Ordering::SeqCst), 0);
    let transfer = h.transfer(id);
    assert_eq!(transfer.direction, TransferDirection::Copy);
    assert_eq!(transfer.source, "/site");
    assert_eq!(transfer.target, "/incoming/site");
    assert_eq!(transfer.source_host.unwrap().name, "Web");
    assert_eq!(
        transfer.target_host.unwrap().id,
        HostId::from("target".to_owned())
    );
    assert_eq!((transfer.files_done, transfer.files_total), (2, 2));
    assert_eq!((transfer.bytes_done, transfer.bytes_total), (6, 6));
}

#[tokio::test]
async fn cancelling_a_host_copy_preserves_the_conflicting_destination_and_releases_its_slot() {
    let h = Harness::new();
    let source = MemoryFs::new();
    source.file("/shared", vec![7; 10_000]);
    source.break_reads("/shared", Break::Stall);
    source.file("/next", "next");
    h.remote.dir("/backup");
    h.remote.file("/backup/shared", "original");
    h.queue.set_concurrency(1);
    let copy = |path: &str| {
        h.queue.copy_remote(
            remote_endpoint(&source, "source", "Web"),
            path.into(),
            remote_endpoint(&h.remote, "target", "Backup"),
            "/backup".into(),
        )
    };

    let first = copy("/shared");
    let next = copy("/next");
    assert_eq!(next_conflict(&h, first).await, "/backup/shared");
    assert_eq!(h.transfer(next).state, TransferState::Queued);
    h.queue.answer(first, ConflictAnswer::Overwrite);
    h.until("copy to make progress", |all| all[0].bytes_done > 0)
        .await;

    h.queue.cancel(first);
    h.until_state(first, TransferState::Cancelled).await;
    h.until_state(next, TransferState::Done).await;
    assert_eq!(
        h.remote.tree("/backup"),
        [
            ("next".into(), Node::File(b"next".to_vec(), 0o644)),
            ("shared".into(), Node::File(b"original".to_vec(), 0o644)),
        ]
    );
    assert_eq!(source.read("/shared"), Some(vec![7; 10_000]));
}

#[tokio::test]
async fn one_host_copy_does_not_block_the_same_path_on_another_destination() {
    let h = Harness::new();
    let source = MemoryFs::new();
    let other_target = MemoryFs::new();
    source.file("/shared", vec![7; 10_000]);
    source.break_reads("/shared", Break::Stall);
    h.queue.set_concurrency(2);

    let copy = |target, id| {
        h.queue.copy_remote(
            remote_endpoint(&source, "source", "Web"),
            "/shared".into(),
            remote_endpoint(target, id, id),
            "/".into(),
        )
    };
    let first = copy(&h.remote, "first-backup");
    h.until("first copy to make progress", |all| all[0].bytes_done > 0)
        .await;

    source.break_reads.lock().unwrap().remove("/shared");
    let second = copy(&other_target, "second-backup");
    h.until_state(second, TransferState::Done).await;
    assert_eq!(other_target.read("/shared"), Some(vec![7; 10_000]));
    assert_eq!(h.transfer(first).state, TransferState::Running);
    h.queue.cancel(first);
    h.until_state(first, TransferState::Cancelled).await;
}

#[tokio::test]
async fn uploading_a_file_copies_it_into_the_remote_directory() {
    let h = Harness::new();
    h.local.dir("/home");
    h.local.file("/home/notes.txt", "hello");
    h.remote.dir("/srv");

    let id = h.upload("/home/notes.txt", "/srv");
    h.until_state(id, TransferState::Done).await;

    assert_eq!(h.remote.read("/srv/notes.txt").unwrap(), b"hello");
    let t = h.transfer(id);
    assert_eq!(t.direction, TransferDirection::Upload);
    assert_eq!(t.name, "notes.txt");
    assert_eq!((t.files_done, t.files_total), (1, 1));
    assert_eq!((t.bytes_done, t.bytes_total), (5, 5));
}

#[tokio::test]
async fn downloading_a_folder_recreates_its_nested_tree_locally() {
    let h = Harness::new();
    h.remote.dir("/srv");
    h.remote.dir("/srv/site");
    h.remote.file("/srv/site/index.html", "<h1>");
    h.remote.dir("/srv/site/assets");
    h.remote.dir("/srv/site/assets/img");
    h.remote
        .file("/srv/site/assets/img/logo.png", vec![7; 10_000]);
    h.remote.file("/srv/site/assets/app.js", "js");
    h.remote.dir("/srv/site/empty");
    h.local.dir("/dl");

    let id = h.download("/srv/site", "/dl");
    h.until_state(id, TransferState::Done).await;

    assert_eq!(h.local.tree("/dl/site"), h.remote.tree("/srv/site"));
    let t = h.transfer(id);
    assert_eq!(t.name, "site");
    assert_eq!((t.files_done, t.files_total), (3, 3));
    assert_eq!((t.bytes_done, t.bytes_total), (10_006, 10_006));
}

#[tokio::test]
async fn uploading_into_an_existing_folder_merges_into_it() {
    let h = Harness::new();
    h.local.dir("/site");
    h.local.file("/site/new.txt", "new");
    h.remote.dir("/site");
    h.remote.file("/site/old.txt", "old");

    let id = h.upload("/site", "/");
    h.until_state(id, TransferState::Done).await;

    assert_eq!(h.remote.read("/site/old.txt").unwrap(), b"old");
    assert_eq!(h.remote.read("/site/new.txt").unwrap(), b"new");
}

#[tokio::test]
async fn at_most_the_concurrency_limit_runs_at_once_and_the_rest_wait() {
    let (local, gate) = MemoryFs::gated();
    let h = Harness::with(local, MemoryFs::new());
    for i in 0..5 {
        h.local.file(&format!("/f{i}"), "x");
    }

    let ids: Vec<_> = (0..5).map(|i| h.upload(&format!("/f{i}"), "/")).collect();
    h.until("three reads to start", |_| {
        h.local.reading.load(Ordering::SeqCst) == 3
    })
    .await;
    tokio::time::sleep(Duration::from_millis(30)).await;

    let states: Vec<_> = ids.iter().map(|id| h.transfer(*id).state).collect();
    assert_eq!(
        states,
        [
            TransferState::Running,
            TransferState::Running,
            TransferState::Running,
            TransferState::Queued,
            TransferState::Queued,
        ]
    );

    gate.add_permits(100);
    h.until_settled().await;
    assert_eq!(h.local.max_reading.load(Ordering::SeqCst), 3);
    assert!(ids
        .iter()
        .all(|id| h.transfer(*id).state == TransferState::Done));
}

#[tokio::test]
async fn raising_the_concurrency_starts_waiting_transfers() {
    let (local, gate) = MemoryFs::gated();
    let h = Harness::with(local, MemoryFs::new());
    h.queue.set_concurrency(1);
    for i in 0..3 {
        h.local.file(&format!("/f{i}"), "x");
        h.upload(&format!("/f{i}"), "/");
    }
    h.until("one read", |_| h.local.reading.load(Ordering::SeqCst) == 1)
        .await;

    h.queue.set_concurrency(3);

    h.until("three reads", |_| {
        h.local.reading.load(Ordering::SeqCst) == 3
    })
    .await;
    gate.add_permits(100);
    h.until_settled().await;
}

/// A local folder `/up` with `a`, `b` and `c`, all of which already exist
/// remotely (as "old").
fn conflicting_upload() -> Harness {
    let h = Harness::new();
    h.local.dir("/up");
    h.remote.dir("/up");
    for name in ["a", "b", "c"] {
        h.local.file(&format!("/up/{name}"), "new");
        h.remote.file(&format!("/up/{name}"), "old");
    }
    h
}

fn conflict_path(t: &Transfer) -> Option<String> {
    match &t.state {
        TransferState::Conflict { path } => Some(path.clone()),
        _ => None,
    }
}

async fn next_conflict(h: &Harness, id: sshastra_core::files::TransferId) -> String {
    h.until("a conflict", |all| {
        all.iter().any(|t| t.id == id && conflict_path(t).is_some())
    })
    .await;
    conflict_path(&h.transfer(id)).unwrap()
}

#[tokio::test]
async fn an_existing_file_is_overwritten_or_skipped_as_the_user_answers_each_time() {
    let h = conflicting_upload();
    let id = h.upload("/up", "/");

    assert_eq!(next_conflict(&h, id).await, "/up/a");
    h.queue.answer(id, ConflictAnswer::Overwrite);
    assert_eq!(next_conflict(&h, id).await, "/up/b");
    h.queue.answer(id, ConflictAnswer::Skip);
    assert_eq!(next_conflict(&h, id).await, "/up/c");
    h.queue.answer(id, ConflictAnswer::Overwrite);
    h.until_state(id, TransferState::Done).await;

    assert_eq!(h.remote.read("/up/a").unwrap(), b"new");
    assert_eq!(h.remote.read("/up/b").unwrap(), b"old");
    assert_eq!(h.remote.read("/up/c").unwrap(), b"new");
    let t = h.transfer(id);
    assert_eq!((t.files_done, t.bytes_done), (3, 9));
}

#[tokio::test]
async fn overwrite_all_answers_every_later_conflict() {
    let h = conflicting_upload();
    let id = h.upload("/up", "/");

    next_conflict(&h, id).await;
    h.queue.answer(id, ConflictAnswer::OverwriteAll);
    h.until_state(id, TransferState::Done).await;

    for name in ["a", "b", "c"] {
        assert_eq!(h.remote.read(&format!("/up/{name}")).unwrap(), b"new");
    }
}

#[tokio::test]
async fn skip_all_answers_every_later_conflict_including_other_transfers() {
    let h = conflicting_upload();
    h.local.file("/d", "new");
    h.remote.file("/d", "old");
    h.queue.set_concurrency(1);
    let first = h.upload("/up", "/");
    let second = h.upload("/d", "/");

    next_conflict(&h, first).await;
    h.queue.answer(first, ConflictAnswer::SkipAll);
    h.until_settled().await;

    for path in ["/up/a", "/up/b", "/up/c", "/d"] {
        assert_eq!(h.remote.read(path).unwrap(), b"old", "{path}");
    }
    assert_eq!(h.transfer(second).state, TransferState::Done);
    assert!(h
        .events_for(second)
        .iter()
        .all(|t| conflict_path(t).is_none()));
}

#[tokio::test]
async fn an_answer_to_all_lasts_only_until_the_queue_is_idle() {
    let h = conflicting_upload();
    let id = h.upload("/up", "/");
    next_conflict(&h, id).await;
    h.queue.answer(id, ConflictAnswer::SkipAll);
    h.until_settled().await;

    let again = h.upload("/up", "/");

    assert_eq!(next_conflict(&h, again).await, "/up/a");
}

#[tokio::test]
async fn cancelling_a_queued_transfer_never_starts_it() {
    let (local, gate) = MemoryFs::gated();
    let h = Harness::with(local, MemoryFs::new());
    h.queue.set_concurrency(1);
    h.local.file("/a", "a");
    h.local.file("/b", "b");
    let a = h.upload("/a", "/");
    let b = h.upload("/b", "/");

    h.queue.cancel(b);
    gate.add_permits(100);
    h.until_settled().await;

    assert_eq!(h.transfer(a).state, TransferState::Done);
    assert_eq!(h.transfer(b).state, TransferState::Cancelled);
    assert_eq!(h.remote.read("/b"), None);
}

#[tokio::test]
async fn cancelling_a_running_transfer_stops_it_and_frees_its_slot() {
    let (local, gate) = MemoryFs::gated();
    let h = Harness::with(local, MemoryFs::new());
    h.queue.set_concurrency(1);
    h.local.file("/a", "a");
    h.local.file("/b", "b");
    let a = h.upload("/a", "/");
    let b = h.upload("/b", "/");
    h.until("a to read", |_| h.local.reading.load(Ordering::SeqCst) == 1)
        .await;

    h.queue.cancel(a);
    h.until_state(a, TransferState::Cancelled).await;
    gate.add_permits(100);
    h.until_state(b, TransferState::Done).await;

    assert_eq!(h.local.reading.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cancelling_overwrite_all_keeps_the_in_progress_original_and_finished_replacements() {
    let h = conflicting_upload();
    h.local.file("/up/b", vec![7u8; 10_000]);
    h.local.break_reads("/up/b", Break::Stall);
    h.remote.set_mode("/up/a", 0o750).unwrap();

    let id = h.upload("/up", "/");
    next_conflict(&h, id).await;
    h.queue.answer(id, ConflictAnswer::OverwriteAll);
    h.until("b to be partly written", |all| all[0].bytes_done > 3)
        .await;

    h.queue.cancel(id);
    h.until_state(id, TransferState::Cancelled).await;

    assert_eq!(
        h.remote.tree("/up"),
        [
            ("a".into(), Node::File(b"new".to_vec(), 0o750)),
            ("b".into(), Node::File(b"old".to_vec(), 0o644)),
            ("c".into(), Node::File(b"old".to_vec(), 0o644)),
        ]
    );
}

#[tokio::test]
async fn a_new_upload_is_visible_at_its_final_name_only_after_completion() {
    let h = Harness::new();
    let gate = Arc::new(Notify::new());
    *h.local.pause_after_first.lock().unwrap() = Some(gate.clone());
    h.local.file("/upload", vec![7; 10_000]);
    h.remote.dir("/remote");

    let id = h.upload("/upload", "/remote");
    h.until("upload to write its first chunk", |all| {
        all[0].bytes_done > 0
    })
    .await;
    assert_eq!(h.remote.read("/remote/upload"), None);
    let entries = h.remote.tree("/remote");
    assert_eq!(entries.len(), 1);
    assert!(entries[0].0.starts_with('.'));

    gate.notify_one();
    h.until_state(id, TransferState::Done).await;
    assert_eq!(
        h.remote.tree("/remote"),
        [("upload".into(), Node::File(vec![7; 10_000], 0o644))]
    );
}

#[tokio::test]
async fn a_new_download_leaves_a_file_created_at_its_final_name_during_copy() {
    let h = Harness::new();
    let gate = Arc::new(Notify::new());
    *h.remote.pause_after_first.lock().unwrap() = Some(gate.clone());
    h.remote.file("/download", vec![7; 10_000]);
    h.local.dir("/down");

    let id = h.download("/download", "/down");
    h.until("download to write its first chunk", |all| {
        all[0].bytes_done > 0
    })
    .await;
    h.local.file("/down/download", "created during copy");
    gate.notify_one();
    h.until_settled().await;

    assert!(matches!(h.transfer(id).state, TransferState::Failed { .. }));
    assert_eq!(
        h.local.read("/down/download").as_deref(),
        Some(&b"created during copy"[..])
    );
    assert_eq!(h.local.tree("/down").len(), 2);
    h.queue.retry(id);
    next_conflict(&h, id).await;
    h.queue.answer(id, ConflictAnswer::Skip);
    h.until_state(id, TransferState::Done).await;
    assert_eq!(h.local.tree("/down").len(), 1);
    assert_eq!(
        h.local.read("/down/download").as_deref(),
        Some(&b"created during copy"[..])
    );
}

#[tokio::test]
async fn a_successful_download_overwrite_preserves_permissions() {
    let h = Harness::new();
    h.remote.file("/download", "new");
    h.local.dir("/down");
    h.local.file("/down/download", "old");
    h.local.set_mode("/down/download", 0o640).unwrap();

    let id = h.download("/download", "/down");
    next_conflict(&h, id).await;
    h.queue.answer(id, ConflictAnswer::Overwrite);
    h.until_state(id, TransferState::Done).await;

    assert_eq!(
        h.local.tree("/down"),
        [("download".into(), Node::File(b"new".to_vec(), 0o640))]
    );
}

#[tokio::test]
async fn a_writable_file_in_a_read_only_directory_is_overwritten_with_a_warning() {
    let h = conflicting_upload();
    h.remote.deny_creation.lock().unwrap().insert("/up".into());

    let id = h.upload("/up", "/");
    next_conflict(&h, id).await;
    h.queue.answer(id, ConflictAnswer::OverwriteAll);
    h.until_state(id, TransferState::Done).await;

    for name in ["a", "b", "c"] {
        assert_eq!(h.remote.read(&format!("/up/{name}")).unwrap(), b"new");
    }
    assert!(h.transfer(id).unprotected);
    assert!(h
        .events_for(id)
        .iter()
        .any(|t| t.unprotected && t.state == TransferState::Running));
}

#[tokio::test]
async fn a_stale_partial_does_not_block_a_warned_overwrite_in_a_read_only_directory() {
    let h = Harness::new();
    h.local.file("/file", vec![1; 10_000]);
    h.remote.dir("/up");
    h.remote.file("/up/file", "old");
    h.local.break_reads("/file", Break::Fail);

    let id = h.upload("/file", "/up");
    next_conflict(&h, id).await;
    h.queue.answer(id, ConflictAnswer::Overwrite);
    h.until_settled().await;
    assert!(matches!(h.transfer(id).state, TransferState::Failed { .. }));
    assert_eq!(h.remote.tree("/up").len(), 2);

    let replacement = vec![2; 10_000];
    h.local.break_reads.lock().unwrap().clear();
    h.local.file("/file", replacement.clone());
    h.remote.deny_creation.lock().unwrap().insert("/up".into());
    h.queue.retry(id);
    next_conflict(&h, id).await;
    h.queue.answer(id, ConflictAnswer::Overwrite);
    h.until_state(id, TransferState::Done).await;

    assert_eq!(h.remote.read("/up/file"), Some(replacement));
    assert!(h.transfer(id).unprotected);
}

#[tokio::test]
async fn cancelling_while_staging_opens_does_not_fall_back_to_truncating_the_target() {
    let h = Harness::new();
    h.local.file("/file", "new");
    h.remote.file("/file", "original");
    h.remote.deny_creation.lock().unwrap().insert("/".into());
    let gate = Arc::new(Semaphore::new(0));
    *h.remote.stage_open_gate.lock().unwrap() = Some(gate.clone());

    let id = h.upload("/file", "/");
    next_conflict(&h, id).await;
    h.queue.answer(id, ConflictAnswer::Overwrite);
    tokio::time::timeout(
        Duration::from_secs(5),
        h.remote.stage_open_started.notified(),
    )
    .await
    .unwrap();
    h.queue.cancel(id);
    gate.add_permits(1);
    h.until_state(id, TransferState::Cancelled).await;

    assert_eq!(h.remote.read("/file").as_deref(), Some(&b"original"[..]));
    assert!(h.events_for(id).iter().all(|t| !t.unprotected));
}

#[tokio::test]
async fn separate_queues_can_overwrite_the_same_destination_without_sharing_an_active_stage() {
    let remote = MemoryFs::new();
    remote.file("/file", "original");
    let first = Harness::with(MemoryFs::new(), remote.clone());
    let second = Harness::with(MemoryFs::new(), remote.clone());
    let gate = Arc::new(Notify::new());
    *first.local.pause_after_first.lock().unwrap() = Some(gate.clone());
    let first_bytes = vec![1; 10_000];
    let second_bytes = vec![2; 10_000];
    first.local.file("/file", first_bytes.clone());
    second.local.file("/file", second_bytes.clone());

    let a = first.upload("/file", "/");
    next_conflict(&first, a).await;
    first.queue.answer(a, ConflictAnswer::Overwrite);
    first
        .until("first copy to have written", |all| all[0].bytes_done > 0)
        .await;
    assert_eq!(remote.read("/file").as_deref(), Some(&b"original"[..]));

    let b = second.upload("/file", "/");
    next_conflict(&second, b).await;
    second.queue.answer(b, ConflictAnswer::Overwrite);
    second.until_state(b, TransferState::Done).await;
    assert_eq!(remote.read("/file"), Some(second_bytes));

    gate.notify_one();
    first.until_state(a, TransferState::Done).await;
    assert_eq!(remote.read("/file"), Some(first_bytes));
    assert_eq!(remote.list_path("/").unwrap().len(), 1);
}

#[tokio::test]
async fn an_interrupted_overwrite_keeps_the_original_in_both_directions() {
    let h = Harness::new();
    h.local.dir("/up");
    h.local.file("/up/upload", vec![7; 10_000]);
    h.remote.dir("/remote");
    h.remote.file("/remote/upload", "old upload");
    h.remote.file("/remote/download", vec![7; 10_000]);
    h.local.dir("/down");
    h.local.file("/down/download", "old download");
    *h.remote.fail_write_after.lock().unwrap() = Some(5000);
    *h.local.fail_write_after.lock().unwrap() = Some(5000);

    let upload = h.upload("/up/upload", "/remote");
    next_conflict(&h, upload).await;
    h.queue.answer(upload, ConflictAnswer::Overwrite);
    h.until_settled().await;
    let download = h.download("/remote/download", "/down");
    next_conflict(&h, download).await;
    h.queue.answer(download, ConflictAnswer::Overwrite);
    h.until_settled().await;

    for id in [upload, download] {
        let TransferState::Failed { message } = h.transfer(id).state else {
            panic!("expected write failure");
        };
        assert!(message.contains("write failed"), "{message}");
    }
    assert_eq!(
        h.remote.read("/remote/upload").as_deref(),
        Some(&b"old upload"[..])
    );
    assert_eq!(
        h.local.read("/down/download").as_deref(),
        Some(&b"old download"[..])
    );
    for (fs, dir, files) in [(&h.local, "/down", 2), (&h.remote, "/remote", 3)] {
        let tree = fs.tree(dir);
        assert_eq!(tree.len(), files);
        assert!(tree.iter().any(|(name, node)| name.starts_with('.')
            && matches!(node, Node::File(data, _) if data == &vec![7; 5000])));
    }
}

#[tokio::test]
async fn interrupted_transfers_resume_from_their_staged_bytes() {
    for direction in [
        TransferDirection::Upload,
        TransferDirection::Download,
        TransferDirection::Copy,
    ] {
        let h = Harness::new();
        let other_remote = MemoryFs::new();
        let (source, target) = match direction {
            TransferDirection::Upload => (&h.local, &h.remote),
            TransferDirection::Download => (&h.remote, &h.local),
            TransferDirection::Copy => (&other_remote, &h.remote),
        };
        let bytes: Vec<_> = (0..400_000).map(|i| (i % 251) as u8).collect();
        source.file("/big", bytes.clone());
        target.dir("/to");
        *target.fail_write_after.lock().unwrap() = Some(300_000);
        let id = match direction {
            TransferDirection::Upload => h.upload("/big", "/to"),
            TransferDirection::Download => h.download("/big", "/to"),
            TransferDirection::Copy => h.queue.copy_remote(
                remote_endpoint(source, "source", "Web"),
                "/big".into(),
                remote_endpoint(target, "target", "Backup"),
                "/to".into(),
            ),
        };
        h.until_settled().await;
        assert!(matches!(h.transfer(id).state, TransferState::Failed { .. }));
        assert_eq!(target.read("/to/big"), None);
        let entries = target.tree("/to");
        assert_eq!(entries.len(), 1);
        assert!(matches!(&entries[0].1, Node::File(data, _) if data == &bytes[..300_000]));

        *target.fail_write_after.lock().unwrap() = None;
        let attempt = h.events_for(id).len();
        let read_before = source.read_bytes.load(Ordering::SeqCst);
        let written_before = target.written_bytes.load(Ordering::SeqCst);
        h.queue.retry(id);
        h.until_state(id, TransferState::Done).await;
        assert_eq!(
            target.written_bytes.load(Ordering::SeqCst) - written_before,
            100_000
        );
        assert!(source.read_bytes.load(Ordering::SeqCst) - read_before < bytes.len());
        assert_eq!(target.read("/to/big"), Some(bytes));
        let events = h.events_for(id);
        assert!(events[attempt..]
            .iter()
            .any(|t| t.state == TransferState::Running && t.bytes_done == 300_000));
        assert!(
            events[attempt..].iter().all(|t| t.bytes_done > 0),
            "the retry briefly reset progress: {:?}",
            &events[attempt..]
        );
        assert_eq!(h.transfer(id).bytes_done, 400_000);
        assert_eq!(target.tree("/to").len(), 1);
    }
}

#[tokio::test]
async fn a_retry_copies_the_new_source_when_the_old_prefix_is_invalid() {
    // Same size with different contents, then a source shorter than the partial.
    for new_size in [160_000, 40_000] {
        let h = Harness::new();
        h.local.file("/file", vec![1; 160_000]);
        *h.remote.fail_write_after.lock().unwrap() = Some(80_000);
        let id = h.upload("/file", "/");
        h.until_settled().await;
        assert!(matches!(h.transfer(id).state, TransferState::Failed { .. }));

        let new_contents = vec![2; new_size];
        h.local.file("/file", new_contents.clone());
        *h.remote.fail_write_after.lock().unwrap() = None;
        let written = h.remote.written_bytes.load(Ordering::SeqCst);

        h.queue.retry(id);
        h.until_state(id, TransferState::Done).await;
        assert_eq!(h.remote.read("/file"), Some(new_contents));
        assert_eq!(
            h.remote.written_bytes.load(Ordering::SeqCst) - written,
            new_size
        );
    }
}

#[tokio::test]
async fn failing_to_open_a_changed_source_does_not_relabel_the_old_partial() {
    let h = Harness::new();
    let original = vec![1; 100_000];
    h.local.file("/file", original.clone());
    *h.remote.fail_write_after.lock().unwrap() = Some(80_000);
    let id = h.upload("/file", "/");
    h.until_settled().await;
    assert!(matches!(h.transfer(id).state, TransferState::Failed { .. }));

    // The source metadata changed, although the entire sampled tail matches.
    let mut replacement = original;
    replacement[0] = 2;
    h.local.file("/file", replacement.clone());
    h.local.set_mode("/file", 0o600).unwrap();
    h.local.fail_next_read("/file");
    *h.remote.fail_write_after.lock().unwrap() = None;

    h.queue.retry(id);
    h.until_settled().await;
    assert!(matches!(h.transfer(id).state, TransferState::Failed { .. }));

    h.queue.retry(id);
    h.until_state(id, TransferState::Done).await;
    assert!(h.remote.read("/file") == Some(replacement));
}

#[tokio::test]
async fn a_new_queue_can_adopt_or_replace_an_abandoned_stage() {
    for source_changed in [false, true] {
        let old = Harness::new();
        let size = 10_000;
        old.local.file("/file", vec![1; size]);
        old.local.break_reads("/file", Break::Fail);
        let id = old.upload("/file", "/");
        old.until_settled().await;
        assert!(matches!(
            old.transfer(id).state,
            TransferState::Failed { .. }
        ));
        assert_eq!(old.remote.written_bytes.load(Ordering::SeqCst), 4096);
        let h = Harness::with(old.local.clone(), old.remote.clone());
        drop(old);
        h.local.break_reads.lock().unwrap().clear();
        let bytes = vec![if source_changed { 2 } else { 1 }; size];
        h.local.file("/file", bytes.clone());

        let id = h.upload("/file", "/");
        h.until_state(id, TransferState::Done).await;
        assert_eq!(h.remote.read("/file"), Some(bytes));
        let written = h.remote.written_bytes.load(Ordering::SeqCst) - 4096;
        assert_eq!(written, if source_changed { size } else { size - 4096 });
    }
}

#[tokio::test]
async fn removing_a_failed_download_deletes_its_staging_file() {
    let h = Harness::new();
    h.remote.file("/file", vec![1; 20_000]);
    h.local.dir("/down");
    *h.local.fail_write_after.lock().unwrap() = Some(5000);
    let id = h.download("/file", "/down");
    h.until_settled().await;
    assert!(matches!(h.transfer(id).state, TransferState::Failed { .. }));
    assert_eq!(h.local.tree("/down").len(), 1);

    h.queue.remove(&[id]);

    h.until("the abandoned download to be deleted", |all| {
        all.is_empty() && h.local.tree("/down").is_empty()
    })
    .await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_download_replaces_a_staging_symlink_without_writing_through_it() {
    use sshastra_core::files::DiskFs;
    use std::os::unix::fs::symlink;

    let h = Harness::new();
    let bytes = vec![9; 20_000];
    h.remote.file("/file", bytes.clone());
    h.remote.break_reads("/file", Break::Fail);
    let scratch = tempfile::tempdir().unwrap();
    let target = scratch.path().join("downloads");
    std::fs::create_dir(&target).unwrap();
    let queue = TransferQueue::new(Arc::new(DiskFs), |_| {});
    let id = queue.download(h.opener(), "/file".into(), target.clone());
    let wait = |condition: fn(&TransferState) -> bool| {
        let queue = &queue;
        async move {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if condition(&queue.list()[0].state) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            })
            .await
            .unwrap();
        }
    };
    wait(|state| matches!(state, TransferState::Failed { .. })).await;
    let stage = std::fs::read_dir(&target)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(std::fs::read(&stage).unwrap(), &bytes[..4096]);
    std::fs::remove_file(&stage).unwrap();
    let other = scratch.path().join("other");
    std::fs::write(&other, &bytes[..4096]).unwrap();
    symlink(&other, &stage).unwrap();

    h.remote.break_reads.lock().unwrap().clear();
    queue.retry(id);
    wait(|state| *state == TransferState::Done).await;

    assert_eq!(std::fs::read(other).unwrap(), &bytes[..4096]);
    let file = target.join("file");
    assert!(std::fs::symlink_metadata(&file)
        .unwrap()
        .file_type()
        .is_file());
    assert_eq!(std::fs::read(file).unwrap(), bytes);
    assert!(!stage.exists());
}

#[tokio::test]
async fn a_failed_upload_removed_offline_is_cleaned_up_after_reconnect() {
    let h = Harness::new();
    h.local.file("/file", vec![1; 20_000]);
    h.remote.dir("/to");
    *h.remote.fail_write_after.lock().unwrap() = Some(5000);
    let connected = Arc::new(AtomicBool::new(true));
    let opens = Arc::new(AtomicUsize::new(0));
    let open: OpenRemote = {
        let connected = connected.clone();
        let opens = opens.clone();
        let remote = h.remote.clone();
        Arc::new(move || {
            let live = connected.load(Ordering::SeqCst);
            opens.fetch_add(1, Ordering::SeqCst);
            let remote: Arc<dyn RemoteFs> = remote.clone();
            Box::pin(async move {
                if live {
                    Ok(remote)
                } else {
                    Err(FsError::NotConnected)
                }
            })
        })
    };
    let id = h.queue.upload(open, PathBuf::from("/file"), "/to".into());
    h.until_settled().await;
    assert!(matches!(h.transfer(id).state, TransferState::Failed { .. }));
    assert_eq!(h.remote.tree("/to").len(), 1);

    connected.store(false, Ordering::SeqCst);
    h.queue.remove(&[id]);
    h.until("an offline cleanup attempt", |_| {
        opens.load(Ordering::SeqCst) == 2
    })
    .await;
    assert_eq!(h.remote.tree("/to").len(), 1);

    connected.store(true, Ordering::SeqCst);
    h.until("the orphaned upload to be deleted", |_| {
        h.remote.tree("/to").is_empty()
    })
    .await;
}

#[tokio::test]
async fn removing_a_failed_transfer_leaves_a_newer_transfers_stage_available() {
    let h = Harness::new();
    h.local.dir("/first");
    h.local.dir("/second");
    h.remote.dir("/to");
    h.local.file("/first/file", vec![1; 130_000]);
    h.local.file("/second/file", vec![2; 140_000]);
    *h.remote.fail_write_after.lock().unwrap() = Some(65_000);
    let first = h.upload("/first/file", "/to");
    h.until_settled().await;
    *h.remote.fail_write_after.lock().unwrap() = Some(75_000);
    let second = h.upload("/second/file", "/to");
    h.until_settled().await;
    assert!(matches!(
        h.transfer(second).state,
        TransferState::Failed { .. }
    ));
    assert!(matches!(&h.remote.tree("/to")[0].1, Node::File(data, _) if data == &vec![2; 75_000]));

    h.queue.remove(&[first]);
    tokio::task::yield_now().await;
    *h.remote.fail_write_after.lock().unwrap() = None;
    let written = h.remote.written_bytes.load(Ordering::SeqCst);
    h.queue.retry(second);
    h.until_state(second, TransferState::Done).await;
    assert_eq!(
        h.remote.written_bytes.load(Ordering::SeqCst) - written,
        65_000
    );
    assert_eq!(h.remote.read("/to/file"), Some(vec![2; 140_000]));
}

#[tokio::test]
async fn two_transfers_to_one_destination_can_finish_in_order() {
    let h = Harness::new();
    h.local.dir("/first");
    h.local.dir("/second");
    h.remote.dir("/to");
    h.local.file("/first/file", vec![1; 10_000]);
    h.local.file("/second/file", vec![2; 10_000]);
    let gate = Arc::new(Notify::new());
    *h.local.pause_after_first.lock().unwrap() = Some(gate.clone());
    let first = h.upload("/first/file", "/to");
    h.until("the first transfer to stage its bytes", |all| {
        all[0].bytes_done > 0
    })
    .await;
    *h.local.pause_after_first.lock().unwrap() = None;

    let second = h.upload("/second/file", "/to");
    tokio::task::yield_now().await;
    gate.notify_one();

    h.until_state(first, TransferState::Done).await;
    next_conflict(&h, second).await;
    h.queue.answer(second, ConflictAnswer::Overwrite);
    h.until_state(second, TransferState::Done).await;
    assert_eq!(
        h.remote.tree("/to"),
        [("file".into(), Node::File(vec![2; 10_000], 0o644))]
    );
}

#[tokio::test]
async fn cancelling_during_a_conflict_question_cancels_the_transfer() {
    let h = conflicting_upload();
    let id = h.upload("/up", "/");
    next_conflict(&h, id).await;

    h.queue.cancel(id);

    h.until_state(id, TransferState::Cancelled).await;
    assert_eq!(h.remote.read("/up/a").unwrap(), b"old");
}

#[tokio::test]
async fn a_failed_transfer_says_why_and_a_retry_copies_only_what_is_missing() {
    let h = Harness::new();
    h.local.dir("/up");
    h.local.file("/up/a", "a");
    h.local.file("/up/b", "b");
    h.local.fail_next_read("/up/b");

    let id = h.upload("/up", "/");
    h.until("a failure", |all| {
        matches!(all[0].state, TransferState::Failed { .. })
    })
    .await;
    let TransferState::Failed { message } = h.transfer(id).state else {
        unreachable!()
    };
    assert!(message.contains("read failed"), "{message}");
    assert_eq!(h.remote.read("/up/a").unwrap(), b"a");
    // Were `a` copied again, it would now conflict with the first copy.
    h.queue.retry(id);
    h.until_state(id, TransferState::Done).await;

    assert_eq!(h.remote.read("/up/b").unwrap(), b"b");
    let t = h.transfer(id);
    assert_eq!((t.files_done, t.files_total, t.bytes_done), (2, 2, 2));
}

#[tokio::test]
async fn a_cancelled_transfer_can_be_retried() {
    let h = conflicting_upload();
    let id = h.upload("/up", "/");
    next_conflict(&h, id).await;
    h.queue.cancel(id);
    h.until_state(id, TransferState::Cancelled).await;

    h.queue.retry(id);
    next_conflict(&h, id).await;
    h.queue.answer(id, ConflictAnswer::OverwriteAll);

    h.until_state(id, TransferState::Done).await;
    assert_eq!(h.remote.read("/up/c").unwrap(), b"new");
}

#[tokio::test]
async fn failing_to_open_the_remote_side_fails_the_transfer() {
    let h = Harness::new();
    h.local.file("/a", "a");
    let opener: OpenRemote = Arc::new(|| Box::pin(async { Err(FsError::NotConnected) }));

    let id = h.queue.upload(opener, PathBuf::from("/a"), "/".into());

    h.until_state(
        id,
        TransferState::Failed {
            message: "not connected".into(),
        },
    )
    .await;
}

#[tokio::test]
async fn progress_is_reported_in_order_and_throttled() {
    let h = Harness::new();
    // 4 MiB in 4 KiB reads: a thousand chunks.
    h.local.file("/big", vec![1; 4 << 20]);

    let id = h.upload("/big", "/");
    h.until_state(id, TransferState::Done).await;

    let events = h.events_for(id);
    let states: Vec<_> = events.iter().map(|t| t.state.clone()).collect();
    assert_eq!(states.first(), Some(&TransferState::Queued));
    assert_eq!(states.last(), Some(&TransferState::Done));
    let bytes: Vec<_> = events.iter().map(|t| t.bytes_done).collect();
    assert!(bytes.windows(2).all(|w| w[0] <= w[1]), "{bytes:?}");
    assert_eq!(events.last().unwrap().bytes_done, 4 << 20);
    assert!(events.len() < 50, "{} events", events.len());
}

#[tokio::test]
async fn finished_transfers_can_be_removed_but_running_ones_stay() {
    let (local, gate) = MemoryFs::gated();
    let h = Harness::with(local, MemoryFs::new());
    h.local.file("/a", "a");
    h.local.file("/b", "b");
    let a = h.upload("/a", "/");
    gate.add_permits(1);
    h.until_state(a, TransferState::Done).await;
    let b = h.upload("/b", "/");

    h.queue.remove(&[a, b]);

    let left: Vec<_> = h.queue.list().iter().map(|t| t.id).collect();
    assert_eq!(left, [b]);
    gate.add_permits(1);
    h.until_settled().await;
}
