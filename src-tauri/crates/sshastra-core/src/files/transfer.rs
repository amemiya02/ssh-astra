//! The TransferQueue: uploads and downloads of files and (recursively)
//! folders between the local disk ([`LocalFs`]) and a Host ([`RemoteFs`]).
//!
//! Each [`Transfer`] is one item the user dropped or picked. At most
//! [`TransferQueue::set_concurrency`] transfers run at once (the rest wait,
//! in order); a folder's files copy one after another inside its transfer.
//! Every change goes to the listener as a whole [`Transfer`]; byte progress
//! is throttled to one update per transfer every [`PROGRESS_INTERVAL`].

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{oneshot, watch};

use super::staged_write::{Side, StagedWrite};
use super::{join, FileKind, FileStat, FsError, FsResult, LocalFs, RemoteFs};
use crate::ssh::BoxFuture;

/// The most often a running transfer reports its byte progress.
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Bytes read and written per step of a copy.
const CHUNK: usize = 256 * 1024;

/// Opens the remote side of a transfer. Called at the start of every attempt
/// (so a retry after a dropped Connection gets a fresh session).
pub type OpenRemote =
    Arc<dyn Fn() -> BoxFuture<'static, FsResult<Arc<dyn RemoteFs>>> + Send + Sync>;

/// The `transfers` settings section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TransferSettings {
    /// How many transfers run at once.
    pub concurrency: u32,
}

impl Default for TransferSettings {
    fn default() -> Self {
        Self { concurrency: 3 }
    }
}

impl TransferSettings {
    pub const SECTION: &'static str = "transfers";
    pub const MAX_CONCURRENCY: u32 = 10;

    /// [`Self::concurrency`], within `1..=MAX_CONCURRENCY`.
    pub fn concurrency(&self) -> usize {
        self.concurrency.clamp(1, Self::MAX_CONCURRENCY) as usize
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TransferId(u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TransferState {
    /// Waiting for a free slot.
    Queued,
    Running,
    /// Paused until [`TransferQueue::answer`] says what to do with `path`,
    /// which already exists at the destination.
    Conflict {
        path: String,
    },
    Done,
    Failed {
        message: String,
    },
    Cancelled,
}

impl TransferState {
    fn is_finished(&self) -> bool {
        matches!(self, Self::Done | Self::Failed { .. } | Self::Cancelled)
    }
}

/// One transfer as the transfer panel shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: TransferId,
    pub direction: TransferDirection,
    /// The file or folder name.
    pub name: String,
    /// Where it comes from and goes to (the copy's own path, not its parent).
    pub source: String,
    pub target: String,
    pub state: TransferState,
    /// At least one existing file in this transfer was written in place.
    pub unprotected: bool,
    /// Totals are 0 until the source has been walked.
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub files_done: u64,
    pub files_total: u64,
}

/// What to do with a file that already exists at the destination. The
/// `All` answers hold for every later conflict until the queue is idle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictAnswer {
    Overwrite,
    Skip,
    OverwriteAll,
    SkipAll,
}

type Listener = dyn Fn(&Transfer) + Send + Sync;

/// Runs transfers; see the module docs. [`upload`](Self::upload) and
/// [`download`](Self::download) must be called on a Tokio runtime, which
/// every transfer then runs on; the other methods may be called anywhere.
pub struct TransferQueue {
    inner: Arc<Inner>,
}

struct Inner {
    local: Arc<dyn LocalFs>,
    listener: Box<Listener>,
    state: Mutex<State>,
    /// Held while a conflict question is open, so the user gets one at a time.
    asking: tokio::sync::Mutex<()>,
    /// The runtime of the latest upload/download call.
    runtime: Mutex<Option<tokio::runtime::Handle>>,
}

struct State {
    next_id: u64,
    concurrency: usize,
    running: usize,
    pending: VecDeque<TransferId>,
    entries: BTreeMap<TransferId, Entry>,
    /// An `OverwriteAll` (`true`) or `SkipAll` (`false`) answer.
    answer_all: Option<bool>,
}

struct Entry {
    info: Transfer,
    job: Job,
    /// Files (relative paths) finished in earlier attempts; a retry skips them.
    done: HashSet<String>,
    cancel: Option<watch::Sender<bool>>,
    answer: Option<oneshot::Sender<ConflictAnswer>>,
    last_progress: Option<Instant>,
}

#[derive(Clone)]
struct Job {
    direction: TransferDirection,
    name: String,
    open: OpenRemote,
    /// The local copy's path (upload source / download target).
    local: PathBuf,
    /// The remote copy's path (upload target / download source).
    remote: String,
}

impl TransferQueue {
    /// A queue running [`TransferSettings::default`]'s number of transfers at
    /// once, telling `listener` about every change.
    pub fn new(
        local: Arc<dyn LocalFs>,
        listener: impl Fn(&Transfer) + Send + Sync + 'static,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                local,
                listener: Box::new(listener),
                state: Mutex::new(State {
                    next_id: 0,
                    concurrency: TransferSettings::default().concurrency(),
                    running: 0,
                    pending: VecDeque::new(),
                    entries: BTreeMap::new(),
                    answer_all: None,
                }),
                asking: tokio::sync::Mutex::new(()),
                runtime: Mutex::new(None),
            }),
        }
    }

    /// How many transfers may run at once (at least 1). Raising it starts
    /// waiting ones; lowering it lets running ones finish.
    pub fn set_concurrency(&self, n: usize) {
        self.inner.lock().concurrency = n.max(1);
        self.inner.pump();
    }

    /// Queues copying the local file or folder `local` into the remote
    /// directory `remote_dir`.
    pub fn upload(&self, open: OpenRemote, local: PathBuf, remote_dir: String) -> TransferId {
        let name = local
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| local.display().to_string());
        let remote = join(&remote_dir, &name);
        self.enqueue(Job {
            direction: TransferDirection::Upload,
            name,
            open,
            local,
            remote,
        })
    }

    /// Queues copying the remote file or folder `remote` into the local
    /// directory `local_dir`.
    pub fn download(&self, open: OpenRemote, remote: String, local_dir: PathBuf) -> TransferId {
        let name = remote
            .rsplit('/')
            .find(|s| !s.is_empty())
            .unwrap_or(&remote)
            .to_owned();
        let local = local_dir.join(&name);
        self.enqueue(Job {
            direction: TransferDirection::Download,
            name,
            open,
            local,
            remote,
        })
    }

    /// Stops a waiting or running transfer. What it already copied stays.
    pub fn cancel(&self, id: TransferId) {
        let mut st = self.inner.lock();
        let Some(entry) = st.entries.get_mut(&id) else {
            return;
        };
        match entry.info.state {
            TransferState::Queued => {
                entry.info.state = TransferState::Cancelled;
                let snapshot = entry.info.clone();
                st.pending.retain(|p| *p != id);
                drop(st);
                self.inner.emit(&snapshot);
            }
            TransferState::Running | TransferState::Conflict { .. } => {
                if let Some(cancel) = &entry.cancel {
                    let _ = cancel.send(true);
                }
            }
            _ => {}
        }
    }

    /// Queues a failed or cancelled transfer again. Files it already copied
    /// are not copied again.
    pub fn retry(&self, id: TransferId) {
        let mut st = self.inner.lock();
        let Some(entry) = st.entries.get_mut(&id) else {
            return;
        };
        if !matches!(
            entry.info.state,
            TransferState::Failed { .. } | TransferState::Cancelled
        ) {
            return;
        }
        entry.info.state = TransferState::Queued;
        let snapshot = entry.info.clone();
        st.pending.push_back(id);
        drop(st);
        self.inner.emit(&snapshot);
        self.inner.pump();
    }

    /// Answers transfer `id`'s open conflict question.
    pub fn answer(&self, id: TransferId, answer: ConflictAnswer) {
        let snapshot = {
            let mut st = self.inner.lock();
            let Some(entry) = st.entries.get_mut(&id) else {
                return;
            };
            let Some(sender) = entry.answer.take() else {
                return;
            };
            let _ = sender.send(answer);
            entry.info.state = TransferState::Running;
            let snapshot = entry.info.clone();
            match answer {
                ConflictAnswer::OverwriteAll => st.answer_all = Some(true),
                ConflictAnswer::SkipAll => st.answer_all = Some(false),
                ConflictAnswer::Overwrite | ConflictAnswer::Skip => {}
            }
            snapshot
        };
        self.inner.emit(&snapshot);
    }

    /// Forgets finished transfers among `ids`; others are left alone.
    pub fn remove(&self, ids: &[TransferId]) {
        let mut st = self.inner.lock();
        for id in ids {
            if st
                .entries
                .get(id)
                .is_some_and(|e| e.info.state.is_finished())
            {
                st.entries.remove(id);
            }
        }
    }

    /// Every transfer, oldest first.
    pub fn list(&self) -> Vec<Transfer> {
        self.inner
            .lock()
            .entries
            .values()
            .map(|e| e.info.clone())
            .collect()
    }

    fn enqueue(&self, job: Job) -> TransferId {
        *self.inner.runtime.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(tokio::runtime::Handle::current());
        let (source, target) = match job.direction {
            TransferDirection::Upload => (job.local.display().to_string(), job.remote.clone()),
            TransferDirection::Download => (job.remote.clone(), job.local.display().to_string()),
        };
        let mut st = self.inner.lock();
        st.next_id += 1;
        let id = TransferId(st.next_id);
        let info = Transfer {
            id,
            direction: job.direction,
            name: job.name.clone(),
            source,
            target,
            state: TransferState::Queued,
            unprotected: false,
            bytes_done: 0,
            bytes_total: 0,
            files_done: 0,
            files_total: 0,
        };
        st.entries.insert(
            id,
            Entry {
                info: info.clone(),
                job,
                done: HashSet::new(),
                cancel: None,
                answer: None,
                last_progress: None,
            },
        );
        st.pending.push_back(id);
        drop(st);
        self.inner.emit(&info);
        self.inner.pump();
        id
    }
}

/// Why an attempt stopped early.
enum Stop {
    Cancelled,
    Failed(FsError),
}

impl From<FsError> for Stop {
    fn from(e: FsError) -> Self {
        Self::Failed(e)
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn emit(&self, transfer: &Transfer) {
        (self.listener)(transfer);
    }

    /// Changes transfer `id` and tells the listener.
    fn update(&self, id: TransferId, change: impl FnOnce(&mut Entry)) {
        let snapshot = {
            let mut st = self.lock();
            let Some(entry) = st.entries.get_mut(&id) else {
                return;
            };
            change(entry);
            entry.info.clone()
        };
        self.emit(&snapshot);
    }

    /// Starts waiting transfers while there are free slots.
    fn pump(self: &Arc<Self>) {
        loop {
            let (id, job, cancelled, snapshot) = {
                let mut st = self.lock();
                if st.running >= st.concurrency {
                    return;
                }
                let Some(id) = st.pending.pop_front() else {
                    return;
                };
                st.running += 1;
                let entry = st
                    .entries
                    .get_mut(&id)
                    .expect("a pending transfer is listed");
                let (cancel, cancelled) = watch::channel(false);
                entry.cancel = Some(cancel);
                entry.last_progress = None;
                entry.info.state = TransferState::Running;
                (id, entry.job.clone(), cancelled, entry.info.clone())
            };
            self.emit(&snapshot);
            let inner = Arc::clone(self);
            let runtime = self
                .runtime
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone()
                .expect("a transfer was queued on a runtime");
            runtime.spawn(async move {
                let result = inner.attempt(id, &job, cancelled).await;
                inner.finish(id, result);
            });
        }
    }

    fn finish(self: &Arc<Self>, id: TransferId, result: Result<(), Stop>) {
        let snapshot = {
            let mut st = self.lock();
            st.running -= 1;
            if st.running == 0 && st.pending.is_empty() {
                st.answer_all = None;
            }
            let entry = st
                .entries
                .get_mut(&id)
                .expect("a running transfer is listed");
            entry.cancel = None;
            entry.answer = None;
            entry.info.state = match result {
                Ok(()) => TransferState::Done,
                Err(Stop::Cancelled) => TransferState::Cancelled,
                Err(Stop::Failed(e)) => TransferState::Failed {
                    message: e.to_string(),
                },
            };
            entry.info.clone()
        };
        self.emit(&snapshot);
        self.pump();
    }

    async fn attempt(
        &self,
        id: TransferId,
        job: &Job,
        mut cancelled: watch::Receiver<bool>,
    ) -> Result<(), Stop> {
        let downloading = job.direction == TransferDirection::Download;
        if downloading {
            check_download_name(&job.name)?;
        }
        let remote = Side::Remote(
            cancellable(&mut cancelled, (job.open)()).await?,
            job.remote.clone(),
        );
        let local = Side::Local(Arc::clone(&self.local), job.local.clone());
        let (source, target) = match job.direction {
            TransferDirection::Upload => (local, remote),
            TransferDirection::Download => (remote, local),
        };
        let items = cancellable(&mut cancelled, walk(&source, downloading)).await?;

        self.update(id, |entry| {
            let files = items.iter().filter(|i| !i.is_dir);
            let info = &mut entry.info;
            info.files_total = files.clone().count() as u64;
            info.bytes_total = files.clone().map(|i| i.size).sum();
            let done = files.filter(|i| entry.done.contains(&i.rel));
            info.files_done = done.clone().count() as u64;
            info.bytes_done = done.map(|i| i.size).sum();
        });

        for item in &items {
            let file = target.at(&item.rel);
            if item.is_dir {
                cancellable(&mut cancelled, ensure_dir(&file)).await?;
                continue;
            }
            if self.lock().entries[&id].done.contains(&item.rel) {
                continue;
            }
            let (original, copy) = cancellable(&mut cancelled, async {
                match file.stat().await {
                    Ok(stat) if stat.kind == FileKind::Dir => {
                        Err(FsError::NotADirectory(file.display()).into())
                    }
                    Ok(stat) => Ok((Some(stat), self.overwrite(id, file.display()).await?)),
                    Err(FsError::NotFound(_)) => Ok((None, true)),
                    Err(e) => Err(Stop::from(e)),
                }
            })
            .await?;
            if copy {
                self.copy(
                    id,
                    &source.at(&item.rel),
                    &file,
                    original,
                    &job.open,
                    &mut cancelled,
                )
                .await?;
            } else {
                self.progress(id, item.size);
            }
            self.file_done(id, &item.rel);
        }
        Ok(())
    }

    /// Whether to overwrite `path`: the standing answer, or the user's.
    async fn overwrite(&self, id: TransferId, path: String) -> Result<bool, Stop> {
        if let Some(all) = self.lock().answer_all {
            return Ok(all);
        }
        let _turn = self.asking.lock().await;
        if let Some(all) = self.lock().answer_all {
            return Ok(all);
        }
        let (tx, rx) = oneshot::channel();
        self.update(id, |entry| {
            entry.answer = Some(tx);
            entry.info.state = TransferState::Conflict { path };
        });
        // `TransferQueue::answer` has set the state back to running.
        let answer = rx.await.map_err(|_| Stop::Cancelled)?;
        Ok(matches!(
            answer,
            ConflictAnswer::Overwrite | ConflictAnswer::OverwriteAll
        ))
    }

    async fn copy(
        &self,
        id: TransferId,
        source: &Side,
        target: &Side,
        original: Option<FileStat>,
        open: &OpenRemote,
        cancelled: &mut watch::Receiver<bool>,
    ) -> Result<(), Stop> {
        let mut reader = cancellable(cancelled, source.open_read()).await?;
        // Allow open to finish even if cancellation comes in: the server may
        // have created the file before its reply reaches us.
        let (stage, mut writer, offset) = StagedWrite::begin(target, original).await?;
        if offset > 0 {
            self.progress(id, offset);
        }
        if stage.unprotected() && !self.lock().entries[&id].info.unprotected {
            self.update(id, |entry| entry.info.unprotected = true);
        }
        let copied = cancellable(cancelled, async {
            let mut buf = vec![0; CHUNK];
            loop {
                let n = reader
                    .read(&mut buf)
                    .await
                    .map_err(|e| io_error(&source.display(), e))?;
                if n == 0 {
                    break;
                }
                writer
                    .write_all(&buf[..n])
                    .await
                    .map_err(|e| io_error(&target.display(), e))?;
                self.progress(id, n as u64);
            }
            writer
                .shutdown()
                .await
                .map_err(|e| io_error(&target.display(), e))
        })
        .await;
        drop(writer);

        let result = async {
            copied?;
            stage.prepare().await?;
            if *cancelled.borrow() {
                return Err(Stop::Cancelled);
            }
            // Once publication starts, finish it. A remote replacement can
            // take two requests, and an interrupted rename may have succeeded.
            stage.commit().await?;
            Ok(())
        }
        .await;
        if result.is_err() {
            stage.discard(open).await;
        }
        result
    }

    /// Counts `bytes` more done; tells the listener at most every
    /// [`PROGRESS_INTERVAL`].
    fn progress(&self, id: TransferId, bytes: u64) {
        let snapshot = {
            let mut st = self.lock();
            let Some(entry) = st.entries.get_mut(&id) else {
                return;
            };
            entry.info.bytes_done += bytes;
            let now = Instant::now();
            if entry
                .last_progress
                .is_some_and(|last| now.duration_since(last) < PROGRESS_INTERVAL)
            {
                return;
            }
            entry.last_progress = Some(now);
            entry.info.clone()
        };
        self.emit(&snapshot);
    }

    fn file_done(&self, id: TransferId, rel: &str) {
        let mut st = self.lock();
        if let Some(entry) = st.entries.get_mut(&id) {
            entry.done.insert(rel.to_owned());
            entry.info.files_done += 1;
        }
    }
}

async fn cancellable<T, E>(
    cancelled: &mut watch::Receiver<bool>,
    operation: impl Future<Output = Result<T, E>>,
) -> Result<T, Stop>
where
    Stop: From<E>,
{
    tokio::select! {
        biased;
        _ = cancelled.wait_for(|c| *c) => Err(Stop::Cancelled),
        result = operation => result.map_err(Stop::from),
    }
}

fn io_error(path: &str, e: std::io::Error) -> FsError {
    FsError::Io(format!("{path}: {e}"))
}

/// One thing to create at the destination.
struct Item {
    rel: String,
    is_dir: bool,
    size: u64,
}

/// Accepts only a single filename representable on the receiving filesystem.
fn check_download_name(name: &str) -> FsResult<()> {
    let invalid = matches!(name, "" | "." | "..") || name.contains(['/', '\0']);
    #[cfg(windows)]
    let invalid = invalid || {
        let stem = name
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end_matches(' ')
            .to_ascii_uppercase();
        let reserved_port = stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|num| {
                matches!(
                    num,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            });
        name.contains(['\\', ':', '<', '>', '"', '|', '?', '*'])
            || name.chars().any(|ch| ch <= '\u{1f}')
            || name.ends_with(['.', ' '])
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || reserved_port
    };
    if invalid {
        return Err(FsError::Io(format!("invalid local filename: {name:?}")));
    }
    Ok(())
}

/// The source's folders (each before its contents) and files. Symlinks to
/// files are copied as files; symlinks to folders are not followed (they
/// could loop), nor are sockets, devices and FIFOs.
async fn walk(source: &Side, downloading: bool) -> FsResult<Vec<Item>> {
    let root = source.stat().await?;
    match root.kind {
        FileKind::File => {
            return Ok(vec![Item {
                rel: String::new(),
                is_dir: false,
                size: root.size,
            }])
        }
        FileKind::Dir => {}
        _ => {
            return Err(FsError::Io(format!(
                "{}: not a file or folder",
                source.display()
            )))
        }
    }
    let mut items = Vec::new();
    let mut dirs = vec![String::new()];
    while let Some(dir) = dirs.pop() {
        let mut entries = source.at(&dir).list_dir().await?;
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        items.push(Item {
            rel: dir.clone(),
            is_dir: true,
            size: 0,
        });
        for entry in entries {
            if downloading {
                check_download_name(&entry.name)?;
            }
            let rel = if dir.is_empty() {
                entry.name.clone()
            } else {
                format!("{dir}/{}", entry.name)
            };
            match (entry.kind, entry.link_target) {
                (FileKind::Dir, _) => dirs.push(rel),
                (FileKind::File, _) => items.push(Item {
                    rel,
                    is_dir: false,
                    size: entry.size,
                }),
                (FileKind::Symlink, Some(FileKind::File)) => {
                    let size = source.at(&rel).stat().await?.size;
                    items.push(Item {
                        rel,
                        is_dir: false,
                        size,
                    });
                }
                _ => {}
            }
        }
    }
    Ok(items)
}

/// Makes the destination a directory; an existing one is merged into.
async fn ensure_dir(target: &Side) -> FsResult<()> {
    match target.stat().await {
        Ok(stat) if stat.kind == FileKind::Dir => Ok(()),
        Ok(_) => Err(FsError::NotADirectory(target.display())),
        Err(FsError::NotFound(_)) => target.create_dir().await,
        Err(e) => Err(e),
    }
}
