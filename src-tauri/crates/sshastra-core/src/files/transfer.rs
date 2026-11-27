//! The TransferQueue: copies of files and (recursively) folders between
//! the local disk ([`LocalFs`]) and a Host ([`RemoteFs`]), or between two Hosts.
//!
//! Each [`Transfer`] is one item the user dropped or picked. At most
//! [`TransferQueue::set_concurrency`] transfers run at once (the rest wait,
//! in order); a folder's files copy one after another inside its transfer.
//! Every change goes to the listener as a whole [`Transfer`]; byte progress
//! is throttled to one update per transfer every [`PROGRESS_INTERVAL`].

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{oneshot, watch};

use super::staged_write::{OpenedWrite, Partial, Side, StageLease, StageSlots, StagedWrite};
use super::{join, FileKind, FileStat, FsError, FsResult, LocalFs, RemoteFs};
use crate::{hosts::HostId, ssh::BoxFuture};

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
    Copy,
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

/// A Host's identity and display label at the time of a transfer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferHost {
    pub id: HostId,
    pub name: String,
    #[serde(default)]
    pub temporary: bool,
}

/// The live filesystem opener for a Host-to-Host transfer endpoint.
#[derive(Clone)]
pub struct RemoteTransfer {
    pub host: TransferHost,
    pub open: OpenRemote,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_host: Option<TransferHost>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_host: Option<TransferHost>,
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

/// Runs transfers; see the module docs. [`upload`](Self::upload),
/// [`download`](Self::download), and [`copy_remote`](Self::copy_remote) must
/// be called on a Tokio runtime, which runs every transfer. Other methods
/// may be called anywhere.
pub struct TransferQueue {
    inner: Arc<Inner>,
}

struct Inner {
    local: Arc<dyn LocalFs>,
    listener: Box<Listener>,
    state: Mutex<State>,
    /// Held while a conflict question is open, so the user gets one at a time.
    asking: tokio::sync::Mutex<()>,
    stages: StageSlots,
    /// The runtime of the latest enqueue call.
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
    completed_bytes: u64,
    partials: Vec<StageLease>,
    cancel: Option<watch::Sender<bool>>,
    answer: Option<oneshot::Sender<ConflictAnswer>>,
    last_progress: Option<Instant>,
}

#[derive(Clone)]
struct Job {
    direction: TransferDirection,
    name: String,
    source: Location,
    target: Location,
}

#[derive(Clone)]
enum Location {
    Local(PathBuf),
    Remote {
        path: String,
        open: OpenRemote,
        host: Option<TransferHost>,
    },
}

impl Location {
    fn display(&self) -> String {
        match self {
            Self::Local(path) => path.display().to_string(),
            Self::Remote { path, .. } => path.clone(),
        }
    }

    fn host(&self) -> Option<&TransferHost> {
        match self {
            Self::Local(_) => None,
            Self::Remote { host, .. } => host.as_ref(),
        }
    }

    fn opener(&self) -> Option<&OpenRemote> {
        match self {
            Self::Local(_) => None,
            Self::Remote { open, .. } => Some(open),
        }
    }

    fn is_absolute_remote_path(&self) -> bool {
        matches!(self, Self::Remote { path, .. } if path.starts_with('/') && !path.contains('\0'))
    }

    async fn open(&self, local: &Arc<dyn LocalFs>) -> FsResult<Side> {
        match self {
            Self::Local(path) => Ok(Side::Local(local.clone(), path.clone())),
            Self::Remote { path, open, host } => Ok(Side::Remote(
                open().await?,
                path.clone(),
                host.as_ref().map(|host| host.id.clone()),
            )),
        }
    }
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
                stages: StageSlots::default(),
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
        let path = join(&remote_dir, &name);
        self.enqueue(Job {
            direction: TransferDirection::Upload,
            name,
            source: Location::Local(local),
            target: Location::Remote {
                path,
                open,
                host: None,
            },
        })
    }

    /// Queues copying the remote file or folder `remote` into the local
    /// directory `local_dir`.
    pub fn download(&self, open: OpenRemote, remote: String, local_dir: PathBuf) -> TransferId {
        let name = remote_name(&remote).to_owned();
        let local = local_dir.join(&name);
        self.enqueue(Job {
            direction: TransferDirection::Download,
            name,
            source: Location::Remote {
                path: remote,
                open,
                host: None,
            },
            target: Location::Local(local),
        })
    }

    /// Queues copying an absolute path into a directory on another Host.
    /// Bytes stream through this process using the two live Connections.
    pub fn copy_remote(
        &self,
        source: RemoteTransfer,
        source_path: String,
        target: RemoteTransfer,
        target_dir: String,
    ) -> TransferId {
        let name = remote_name(&source_path).to_owned();
        let path = if target_dir.is_empty() {
            name.clone()
        } else {
            join(&target_dir, &name)
        };
        self.enqueue(Job {
            direction: TransferDirection::Copy,
            name,
            source: Location::Remote {
                path: source_path,
                open: source.open,
                host: Some(source.host),
            },
            target: Location::Remote {
                path,
                open: target.open,
                host: Some(target.host),
            },
        })
    }

    /// Cancels the transfer and discards its incomplete staging files.
    /// What it already copied stays.
    pub fn cancel(&self, id: TransferId) {
        let mut st = self.inner.lock();
        let Some(entry) = st.entries.get_mut(&id) else {
            return;
        };
        match entry.info.state {
            TransferState::Queued | TransferState::Failed { .. } => {
                entry.info.state = TransferState::Cancelled;
                let snapshot = entry.info.clone();
                let partials = std::mem::take(&mut entry.partials);
                st.pending.retain(|p| *p != id);
                drop(st);
                self.inner.schedule_cleanup(partials);
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

    /// Forgets finished transfers among `ids` and schedules cleanup of
    /// their incomplete staging files. Active transfers are left alone.
    pub fn remove(&self, ids: &[TransferId]) {
        let mut st = self.inner.lock();
        let mut partials = Vec::new();
        for id in ids {
            if st
                .entries
                .get(id)
                .is_some_and(|e| e.info.state.is_finished())
            {
                let entry = st
                    .entries
                    .remove(id)
                    .expect("a finished transfer is listed");
                partials.extend(entry.partials);
            }
        }
        drop(st);
        self.inner.schedule_cleanup(partials);
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
        let mut st = self.inner.lock();
        st.next_id += 1;
        let id = TransferId(st.next_id);
        let info = Transfer {
            id,
            direction: job.direction,
            name: job.name.clone(),
            source: job.source.display(),
            target: job.target.display(),
            source_host: job.source.host().cloned(),
            target_host: job.target.host().cloned(),
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
                completed_bytes: 0,
                partials: Vec::new(),
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
            log::info!(
                "transfer id={} direction={:?} state=running",
                id.0,
                snapshot.direction
            );
            self.emit(&snapshot);
            let inner = Arc::clone(self);
            self.runtime().spawn(async move {
                inner.run(id, &job, cancelled).await;
            });
        }
    }

    async fn run(
        self: &Arc<Self>,
        id: TransferId,
        job: &Job,
        mut cancelled: watch::Receiver<bool>,
    ) {
        let sides = cancellable(&mut cancelled, async {
            match job.direction {
                TransferDirection::Download => check_download_name(&job.name)?,
                TransferDirection::Copy => {
                    check_remote_name(&job.name)?;
                    if job.source.host().map(|host| &host.id)
                        == job.target.host().map(|host| &host.id)
                        || !job.source.is_absolute_remote_path()
                        || !job.target.is_absolute_remote_path()
                    {
                        return Err(FsError::Io(
                            "copy requires absolute paths on two different Hosts".into(),
                        ));
                    }
                }
                TransferDirection::Upload => {}
            }
            Ok::<_, FsError>((
                job.source.open(&self.local).await?,
                job.target.open(&self.local).await?,
            ))
        })
        .await;
        let (target, mut result) = match sides {
            Ok((source, target)) => {
                let result = self
                    .attempt(id, job, &source, &target, &mut cancelled)
                    .await;
                (Some(target), result)
            }
            Err(e) => (None, Err(e)),
        };
        if result.is_err() && *cancelled.borrow() {
            result = Err(Stop::Cancelled);
        }
        if matches!(result, Ok(()) | Err(Stop::Cancelled)) {
            let partials = {
                let mut st = self.lock();
                let entry = st
                    .entries
                    .get_mut(&id)
                    .expect("a running transfer is listed");
                std::mem::take(&mut entry.partials)
            };
            let live_target = match &target {
                Some(Side::Remote(fs, ..)) => Some(fs.as_ref()),
                _ => None,
            };
            self.cleanup(partials, live_target).await;
        }
        self.finish(id, result);
    }

    fn runtime(&self) -> tokio::runtime::Handle {
        self.runtime
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .expect("a transfer was queued on a runtime")
    }

    fn schedule_cleanup(self: &Arc<Self>, partials: Vec<StageLease>) {
        if !partials.is_empty() {
            let inner = self.clone();
            self.runtime().spawn(async move {
                inner.cleanup(partials, None).await;
            });
        }
    }

    async fn cleanup(self: &Arc<Self>, partials: Vec<StageLease>, live: Option<&dyn RemoteFs>) {
        for lease in partials {
            if lease.discard(live).await {
                let inner = Arc::downgrade(self);
                self.runtime().spawn(async move {
                    // A Connection must already exist. Retry in the
                    // background without holding a transfer slot or dialing.
                    let mut delay = Duration::from_secs(1);
                    loop {
                        tokio::time::sleep(delay).await;
                        if inner.strong_count() == 0 || !lease.discard(None).await {
                            break;
                        }
                        delay = (delay * 2).min(Duration::from_secs(30));
                    }
                });
            }
        }
    }

    fn finish(self: &Arc<Self>, id: TransferId, result: Result<(), Stop>) {
        match &result {
            Ok(()) => log::info!("transfer id={} state=done", id.0),
            Err(Stop::Cancelled) => log::info!("transfer id={} state=cancelled", id.0),
            Err(Stop::Failed(error)) => {
                log::warn!(
                    "transfer id={} state=failed error={}",
                    id.0,
                    error.log_kind()
                );
            }
        }
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
        source: &Side,
        target: &Side,
        cancelled: &mut watch::Receiver<bool>,
    ) -> Result<(), Stop> {
        let items = cancellable(cancelled, walk(source, job.direction)).await?;

        self.update(id, |entry| {
            let files = items
                .iter()
                .filter_map(|i| Some((&i.rel, i.stat.as_ref()?.size)));
            let info = &mut entry.info;
            info.files_total = files.clone().count() as u64;
            info.bytes_total = files.clone().map(|(_, size)| size).sum();
            let done = files.filter(|(rel, _)| entry.done.contains(*rel));
            info.files_done = done.clone().count() as u64;
            entry.completed_bytes = done.map(|(_, size)| size).sum();
            // Keep the last progress visible while a retry verifies its partial.
            // The first file's actual offset will replace it before copying.
            if entry.partials.is_empty() {
                info.bytes_done = entry.completed_bytes;
            } else {
                info.bytes_done = info
                    .bytes_done
                    .clamp(entry.completed_bytes, info.bytes_total);
            }
        });

        let mut directories = HashMap::new();
        for item in &items {
            let destination = target.at(&item.rel);
            let Some(source_stat) = &item.stat else {
                let directory = cancellable(cancelled, async {
                    ensure_dir(&destination).await?;
                    destination.canonicalize().await
                })
                .await?;
                directories.insert(item.rel.as_str(), directory);
                continue;
            };
            if self.lock().entries[&id].done.contains(&item.rel) {
                continue;
            }
            let file = if item.rel.is_empty() {
                cancellable(cancelled, destination.canonicalize_parent()).await?
            } else {
                let (parent, name) = item.rel.rsplit_once('/').unwrap_or(("", &item.rel));
                directories[parent].at(name)
            };
            let parked = file.sibling()?;
            let slot = self.stages.for_path(&parked);
            let mut partial =
                cancellable(cancelled, async { Ok::<_, FsError>(slot.lock().await) }).await?;
            let (original, copy) = cancellable(cancelled, async {
                match file.stat().await {
                    Ok(stat) if stat.kind == FileKind::Dir => {
                        Err(FsError::NotADirectory(destination.display()).into())
                    }
                    Ok(stat) => Ok((Some(stat), self.overwrite(id, destination.display()).await?)),
                    Err(FsError::NotFound(_)) => Ok((None, true)),
                    Err(e) => Err(Stop::from(e)),
                }
            })
            .await?;
            if copy {
                let source = source.at(&item.rel);
                let mut stage = StagedWrite::new(&file, parked, original);
                let result = self
                    .copy(
                        id,
                        &source,
                        source_stat,
                        &mut stage,
                        partial.as_deref(),
                        cancelled,
                    )
                    .await;
                if result.is_ok() {
                    *partial = None;
                } else {
                    if !*cancelled.borrow() {
                        stage.park().await;
                    }
                    if let Some(retained) = stage.partial(
                        &source,
                        source_stat,
                        job.target.opener(),
                        partial.as_deref(),
                    ) {
                        let retained = Arc::new(retained);
                        *partial = Some(retained.clone());
                        let mut st = self.lock();
                        let leases = &mut st
                            .entries
                            .get_mut(&id)
                            .expect("a running transfer is listed")
                            .partials;
                        leases.retain(|lease| !Arc::ptr_eq(&lease.slot, &slot));
                        leases.push(StageLease {
                            slot: slot.clone(),
                            partial: retained,
                        });
                    }
                }
                result?;
            } else {
                self.set_file_offset(id, 0);
                self.progress(id, source_stat.size);
            }
            self.file_done(id, &item.rel, source_stat.size);
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
        source_stat: &FileStat,
        stage: &mut StagedWrite<'_>,
        previous: Option<&Partial>,
        cancelled: &mut watch::Receiver<bool>,
    ) -> Result<(), Stop> {
        if *cancelled.borrow() {
            return Err(Stop::Cancelled);
        }
        // Let the claim and the open below finish even if cancellation comes
        // in. A server can move or create the file before sending its reply.
        stage.claim(previous).await?;
        let plan = cancellable(cancelled, stage.plan(source, source_stat, previous)).await?;
        let (mut reader, mut writer, unprotected) = match stage.begin(source, plan).await? {
            OpenedWrite::Staged(reader, writer, offset) => {
                self.set_file_offset(id, offset);
                (reader, writer, false)
            }
            OpenedWrite::NeedsInPlace(reader) => {
                if *cancelled.borrow() {
                    return Err(Stop::Cancelled);
                }
                self.set_file_offset(id, 0);
                if !self.lock().entries[&id].info.unprotected {
                    self.update(id, |entry| entry.info.unprotected = true);
                }
                // Publishing the warning can itself let the user cancel.
                if *cancelled.borrow() {
                    return Err(Stop::Cancelled);
                }
                (reader, stage.begin_in_place().await?, true)
            }
        };
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
                    .map_err(|e| io_error(&stage.target().display(), e))?;
                self.progress(id, n as u64);
            }
            writer
                .shutdown()
                .await
                .map_err(|e| io_error(&stage.target().display(), e))
        })
        .await;
        if copied.is_err() && matches!(stage.target(), Side::Local(..)) {
            // A local write may still be running in Tokio's blocking pool.
            // Settle it before cleanup or another copy can use the same path.
            let _ = writer.shutdown().await;
        }
        drop(writer);

        let result = async {
            copied?;
            if !unprotected {
                stage.prepare().await?;
            }
            if *cancelled.borrow() {
                return Err(Stop::Cancelled);
            }
            // Once publication starts, finish it. A remote replacement can
            // take two requests, and an interrupted rename may have succeeded.
            if !unprotected {
                stage.commit().await?;
            }
            Ok(())
        }
        .await;
        if result.is_err() && unprotected {
            stage.discard_unprotected().await;
        }
        result
    }

    fn set_file_offset(&self, id: TransferId, offset: u64) {
        let snapshot = {
            let mut st = self.lock();
            let entry = st
                .entries
                .get_mut(&id)
                .expect("a running transfer is listed");
            let bytes_done = entry.completed_bytes + offset;
            if offset == 0 && entry.info.bytes_done == bytes_done {
                return;
            }
            entry.info.bytes_done = bytes_done;
            entry.last_progress = Some(Instant::now());
            entry.info.clone()
        };
        self.emit(&snapshot);
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

    fn file_done(&self, id: TransferId, rel: &str, size: u64) {
        let mut st = self.lock();
        if let Some(entry) = st.entries.get_mut(&id) {
            entry.done.insert(rel.to_owned());
            entry.completed_bytes += size;
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
    /// Source metadata for a file. A directory has no bytes to copy.
    stat: Option<FileStat>,
}

/// Accepts only a single filename representable on the receiving filesystem.
fn remote_name(path: &str) -> &str {
    path.rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or(path)
}

fn check_remote_name(name: &str) -> FsResult<()> {
    if matches!(name, "" | "." | "..") || name.contains(['/', '\0']) {
        return Err(FsError::Io(format!("invalid remote filename: {name:?}")));
    }
    Ok(())
}

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
async fn walk(source: &Side, direction: TransferDirection) -> FsResult<Vec<Item>> {
    let root = source.stat().await?;
    match root.kind {
        FileKind::File => {
            return Ok(vec![Item {
                rel: String::new(),
                stat: Some(root),
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
            stat: None,
        });
        for entry in entries {
            match direction {
                TransferDirection::Download => check_download_name(&entry.name)?,
                TransferDirection::Copy => check_remote_name(&entry.name)?,
                TransferDirection::Upload => {}
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
                    stat: Some(FileStat {
                        kind: FileKind::File,
                        size: entry.size,
                        modified: entry.modified,
                        permissions: entry.permissions,
                    }),
                }),
                (FileKind::Symlink, Some(FileKind::File)) => {
                    let stat = source.at(&rel).stat().await?;
                    items.push(Item {
                        rel,
                        stat: Some(stat),
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
