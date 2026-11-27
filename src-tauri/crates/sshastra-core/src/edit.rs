//! Remote editing: a remote file is downloaded to a temp file, opened in the
//! user's chosen or system default application, and uploaded again
//! each time it is saved there.
//!
//! [`RemoteEditor`] owns every open edit. Temp files live under its root, one
//! directory per Host (`<root>/<host id>/<edit id>/<file name>`), and are
//! deleted when the edit is closed ([`RemoteEditor::close`]) or the app exits
//! ([`RemoteEditor::close_all`]). The app's root is a per-run folder under a
//! stable base ([`RemoteEditor::start`]), so a run that crashed leaves its
//! files where the next run finds and deletes them.

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Mutex as AsyncMutex};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::files::{FileKind, FileStat, FsError, RemoteFs, READ_FILE_LIMIT};
use crate::hosts::HostId;

/// Opens a local file in the system default or user-selected application.
pub trait Opener: Send + Sync {
    fn open(&self, path: &Path) -> Result<(), String>;
    fn open_application(&self, path: &Path, application: &Path) -> Result<(), String>;
}

/// Identifies an open edit across the IPC boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EditId(u64);

#[derive(Debug, Default, Clone, Copy)]
pub struct OpenEditOptions<'a> {
    pub allow_binary: bool,
    pub application: Option<&'a Path>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedEdit {
    pub id: EditId,
    pub application_fallback: bool,
}

/// What happens to an open edit after it was opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum EditEvent {
    /// A save was noticed and is being uploaded.
    Uploading,
    /// The remote file now holds what was saved.
    Uploaded,
    /// The upload failed; the edit stays open, and the next save or
    /// [`RemoteEditor::retry`] uploads again.
    UploadFailed { reason: String },
    /// The remote file changed. Uploads stay paused until explicitly overwritten.
    #[serde(rename_all = "camelCase")]
    Conflict {
        conflict_id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EditError {
    /// Downloading (or uploading) the remote file failed.
    #[error(transparent)]
    Fs(#[from] FsError),
    /// The temp file could not be written or watched.
    #[error("temp file: {0}")]
    Io(String),
    /// No application could open the file.
    #[error("could not open the file: {0}")]
    Open(String),
    #[error("no such edit")]
    NotOpen,
    #[error("the edit conflict has changed")]
    ConflictExpired,
    /// Only regular files (or links to them) are edited.
    #[error("not a regular file")]
    NotAFile,
    /// The file looks binary (a NUL byte near the start); open it with
    /// [`RemoteEditor::open_binary`] if the user says so.
    #[error("the file looks binary")]
    Binary,
}

/// The largest file opened for editing; bigger ones fail with
/// [`FsError::TooLarge`] (download them instead).
pub const MAX_EDIT_SIZE: u64 = READ_FILE_LIMIT;

/// How much of the file is checked for NUL bytes.
const BINARY_SNIFF: usize = 8 * 1024;

/// How long the file must stay unchanged after a save before it is
/// uploaded: editors often write a file in several steps.
const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(500);

/// Owns a group of open edits and prevents a pending open from adding a lease after teardown.
pub struct EditOwner {
    id: Uuid,
    closed: AtomicBool,
}

impl Default for EditOwner {
    fn default() -> Self {
        Self {
            id: Uuid::new_v4(),
            closed: AtomicBool::new(false),
        }
    }
}

impl EditOwner {
    fn ensure_open(&self) -> Result<(), EditError> {
        if self.closed.load(Ordering::Relaxed) {
            return Err(EditError::NotOpen);
        }
        Ok(())
    }
}

type EditSink = Box<dyn Fn(EditEvent) + Send + Sync>;

pub struct EditSubscription<'a> {
    owner: Option<&'a EditOwner>,
    sink: EditSink,
}

impl<'a> EditSubscription<'a> {
    pub fn new(owner: &'a EditOwner, sink: impl Fn(EditEvent) + Send + Sync + 'static) -> Self {
        Self {
            owner: Some(owner),
            sink: Box::new(sink),
        }
    }

    fn unscoped(sink: impl Fn(EditEvent) + Send + Sync + 'static) -> Self {
        Self {
            owner: None,
            sink: Box::new(sink),
        }
    }

    fn ensure_open(&self) -> Result<(), EditError> {
        if let Some(owner) = self.owner {
            owner.ensure_open()?;
        }
        Ok(())
    }
}

#[derive(Default)]
struct EditEvents {
    sinks: HashMap<Option<Uuid>, EditSink>,
    latest: Option<EditEvent>,
}

impl EditEvents {
    fn subscribe(&mut self, subscription: EditSubscription<'_>) {
        let Some(owner) = subscription.owner else {
            self.sinks.entry(None).or_insert(subscription.sink);
            return;
        };
        // Reopening updates this owner's channel. Replay under the same lock as live sends.
        if let Some(event) = &self.latest {
            (subscription.sink)(event.clone());
        }
        self.sinks.insert(Some(owner.id), subscription.sink);
    }

    fn send(&mut self, event: EditEvent) {
        for sink in self.sinks.values() {
            sink(event.clone());
        }
        self.latest = Some(event);
    }
}

struct Edit {
    target: Arc<EditTarget>,
    /// Ordinary opens reuse the original edit. Conflict copies have their own lifetime.
    primary: bool,
    allow_binary: bool,
    local_path: PathBuf,
    conflict_id: Arc<AtomicU64>,
    events: Arc<Mutex<EditEvents>>,
    requests: mpsc::UnboundedSender<UploadRequest>,
    /// Stops watching when dropped.
    _watcher: RecommendedWatcher,
    uploads: JoinHandle<()>,
}

struct EditTarget {
    fs: Arc<dyn RemoteFs>,
    host_id: HostId,
    remote_path: String,
    /// Serializes revision checks and writes by edits of the same path. The count also
    /// detects sibling uploads that fall within the server's timestamp resolution.
    writes: AsyncMutex<u64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Revision {
    size: u64,
    modified: Option<u64>,
    writes: u64,
}

struct DownloadedEdit {
    revision: Revision,
    contents: Vec<u8>,
}

impl EditTarget {
    async fn revision(&self, writes: u64) -> Result<Revision, EditError> {
        Revision::new(self.fs.stat(&self.remote_path).await?, writes)
    }

    async fn download(&self, writes: u64, allow_binary: bool) -> Result<DownloadedEdit, EditError> {
        let revision = self.revision(writes).await?;
        if revision.size > MAX_EDIT_SIZE {
            return Err(FsError::TooLarge {
                path: self.remote_path.clone(),
                limit: MAX_EDIT_SIZE,
            }
            .into());
        }
        // `read_file` enforces the limit too, should the file have grown.
        let contents = self.fs.read_file(&self.remote_path).await?;
        if !allow_binary && contents.iter().take(BINARY_SNIFF).any(|&b| b == 0) {
            return Err(EditError::Binary);
        }
        Ok(DownloadedEdit { revision, contents })
    }
}

impl Revision {
    fn new(stat: FileStat, writes: u64) -> Result<Self, EditError> {
        if stat.kind != FileKind::File {
            return Err(EditError::NotAFile);
        }
        Ok(Self {
            size: stat.size,
            modified: stat.modified,
            writes,
        })
    }
}

fn conflicted_edit(
    edits: &HashMap<EditId, Edit>,
    id: EditId,
    conflict_id: u64,
) -> Result<&Edit, EditError> {
    let edit = edits.get(&id).ok_or(EditError::NotOpen)?;
    if conflict_id == 0 || edit.conflict_id.load(Ordering::Relaxed) != conflict_id {
        return Err(EditError::ConflictExpired);
    }
    Ok(edit)
}

fn owned_edit<'a>(
    edits: &'a HashMap<EditId, Edit>,
    id: EditId,
    owner: &EditOwner,
) -> Result<&'a Edit, EditError> {
    owner.ensure_open()?;
    edits
        .get(&id)
        .filter(|edit| {
            edit.events
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .sinks
                .contains_key(&Some(owner.id))
        })
        .ok_or(EditError::NotOpen)
}

fn find_open<'a>(
    edits: &'a HashMap<EditId, Edit>,
    host_id: &HostId,
    remote_path: &str,
) -> Option<(EditId, &'a Edit)> {
    edits
        .iter()
        .find(|(_, edit)| {
            edit.primary
                && &edit.target.host_id == host_id
                && edit.target.remote_path == remote_path
        })
        .map(|(id, edit)| (*id, edit))
}

/// Every open remote edit.
pub struct RemoteEditor {
    root: PathBuf,
    opener: Arc<dyn Opener>,
    debounce: Duration,
    next_id: AtomicU64,
    edits: Mutex<HashMap<EditId, Edit>>,
    /// The locked `.lock` file marking a [`start`](Self::start)ed run's root
    /// as in use; released before the root is deleted.
    run_lock: Mutex<Option<File>>,
}

/// The file in a run folder whose lock says its run is still going.
const RUN_LOCK: &str = ".lock";

impl RemoteEditor {
    /// Temp files go under `root`, which belongs to the editor: it is
    /// deleted as a whole by [`close_all`](Self::close_all).
    pub fn new(root: impl Into<PathBuf>, opener: Arc<dyn Opener>) -> Self {
        Self {
            root: root.into(),
            opener,
            debounce: DEFAULT_DEBOUNCE,
            next_id: AtomicU64::new(0),
            edits: Mutex::new(HashMap::new()),
            run_lock: Mutex::new(None),
        }
    }

    /// An editor for this run of the app: deletes the run folders under
    /// `base` whose run has ended (crashed, or exited without cleaning up),
    /// then keeps its temp files in a new run folder of its own, marked as in
    /// use by a lock that ends with the process.
    pub fn start(base: impl AsRef<Path>, opener: Arc<dyn Opener>) -> std::io::Result<Self> {
        let base = base.as_ref();
        std::fs::create_dir_all(base)?;
        remove_ended_runs(base);
        let root = base.join(format!("{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root)?;
        let lock = File::create(root.join(RUN_LOCK))?;
        lock.try_lock().map_err(std::io::Error::other)?;
        let editor = Self::new(root, opener);
        *editor.run_lock.lock().unwrap_or_else(|p| p.into_inner()) = Some(lock);
        Ok(editor)
    }

    pub fn with_debounce(mut self, debounce: Duration) -> Self {
        self.debounce = debounce;
        self
    }

    /// Downloads `remote_path` from `fs` and opens it in the editor; each
    /// later save is uploaded through `fs`, reported to `on_event`. Only a
    /// regular text file up to [`MAX_EDIT_SIZE`] opens: otherwise
    /// [`EditError::NotAFile`], [`FsError::TooLarge`] or [`EditError::Binary`].
    pub async fn open(
        &self,
        fs: Arc<dyn RemoteFs>,
        host_id: &HostId,
        remote_path: &str,
        on_event: impl Fn(EditEvent) + Send + Sync + 'static,
    ) -> Result<EditId, EditError> {
        self.open_with(
            fs,
            host_id,
            remote_path,
            OpenEditOptions::default(),
            on_event,
        )
        .await
        .map(|opened| opened.id)
    }

    /// Like [`open`](Self::open), for a file the user chose to edit although
    /// it looks binary.
    pub async fn open_binary(
        &self,
        fs: Arc<dyn RemoteFs>,
        host_id: &HostId,
        remote_path: &str,
        on_event: impl Fn(EditEvent) + Send + Sync + 'static,
    ) -> Result<EditId, EditError> {
        self.open_with(
            fs,
            host_id,
            remote_path,
            OpenEditOptions {
                allow_binary: true,
                ..OpenEditOptions::default()
            },
            on_event,
        )
        .await
        .map(|opened| opened.id)
    }

    /// Opens a new or existing edit with the current application preference.
    /// If the selected application fails, tries the system default and reports the fallback.
    pub async fn open_with(
        &self,
        fs: Arc<dyn RemoteFs>,
        host_id: &HostId,
        remote_path: &str,
        options: OpenEditOptions<'_>,
        on_event: impl Fn(EditEvent) + Send + Sync + 'static,
    ) -> Result<OpenedEdit, EditError> {
        self.open_subscribed(
            fs,
            host_id,
            remote_path,
            options,
            EditSubscription::unscoped(on_event),
        )
        .await
    }

    pub async fn open_subscribed(
        &self,
        fs: Arc<dyn RemoteFs>,
        host_id: &HostId,
        remote_path: &str,
        options: OpenEditOptions<'_>,
        subscription: EditSubscription<'_>,
    ) -> Result<OpenedEdit, EditError> {
        // Already open: show it again rather than download over unsaved or
        // not yet uploaded changes.
        {
            let edits = self.lock();
            subscription.ensure_open()?;
            if let Some((id, edit)) = find_open(&edits, host_id, remote_path) {
                return self.reopen(id, edit, options.application, subscription);
            }
        }

        // A conflict copy can outlive the original. Ordinary opens of that path
        // must share its upload gate as well.
        let target = self
            .lock()
            .values()
            .find(|edit| &edit.target.host_id == host_id && edit.target.remote_path == remote_path)
            .map(|edit| Arc::clone(&edit.target))
            .unwrap_or_else(|| {
                Arc::new(EditTarget {
                    fs,
                    host_id: host_id.clone(),
                    remote_path: remote_path.to_owned(),
                    writes: AsyncMutex::new(0),
                })
            });
        let writes = target.writes.lock().await;
        let download = target.download(*writes, options.allow_binary).await?;
        // Another Window may have finished opening the same file while this one was downloading it.
        let mut edits = self.lock();
        subscription.ensure_open()?;
        if let Some((id, edit)) = find_open(&edits, host_id, remote_path) {
            return self.reopen(id, edit, options.application, subscription);
        }
        self.register(
            &mut edits,
            target.clone(),
            download,
            true,
            options,
            subscription,
        )
    }

    fn reopen(
        &self,
        id: EditId,
        edit: &Edit,
        application: Option<&Path>,
        subscription: EditSubscription<'_>,
    ) -> Result<OpenedEdit, EditError> {
        let opened = self.launch(id, &edit.local_path, application)?;
        edit.events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .subscribe(subscription);
        Ok(opened)
    }

    /// Opens the current remote version in a second live edit. The original stays paused
    /// with its local work intact. Uses the current application preference.
    pub async fn open_conflict_copy(
        &self,
        id: EditId,
        conflict_id: u64,
        application: Option<&Path>,
        on_event: impl Fn(EditEvent) + Send + Sync + 'static,
    ) -> Result<OpenedEdit, EditError> {
        self.open_conflict_copy_subscribed(
            id,
            conflict_id,
            application,
            EditSubscription::unscoped(on_event),
        )
        .await
    }

    pub async fn open_conflict_copy_subscribed(
        &self,
        id: EditId,
        conflict_id: u64,
        application: Option<&Path>,
        subscription: EditSubscription<'_>,
    ) -> Result<OpenedEdit, EditError> {
        let check = |edits: &HashMap<EditId, Edit>| {
            if let Some(owner) = subscription.owner {
                owned_edit(edits, id, owner)?;
            }
            let edit = conflicted_edit(edits, id, conflict_id)?;
            Ok::<_, EditError>((Arc::clone(&edit.target), edit.allow_binary))
        };
        let (target, allow_binary) = check(&self.lock())?;
        let writes = target.writes.lock().await;
        check(&self.lock())?;
        let download = target.download(*writes, allow_binary).await?;
        let mut edits = self.lock();
        check(&edits)?;
        let options = OpenEditOptions {
            allow_binary,
            application,
        };
        self.register(
            &mut edits,
            target.clone(),
            download,
            false,
            options,
            subscription,
        )
    }

    fn register(
        &self,
        edits: &mut HashMap<EditId, Edit>,
        target: Arc<EditTarget>,
        download: DownloadedEdit,
        primary: bool,
        options: OpenEditOptions<'_>,
        subscription: EditSubscription<'_>,
    ) -> Result<OpenedEdit, EditError> {
        let id = EditId(self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let dir = self
            .root
            .join(dir_name(&target.host_id.to_string()))
            .join(id.0.to_string());
        let local_path = dir.join(file_name(&target.remote_path));
        std::fs::create_dir_all(&dir).map_err(io)?;
        if let Err(error) = std::fs::write(&local_path, &download.contents) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(io(error));
        }

        // Watch the directory, not the file: editors often save by writing
        // a new file and renaming it over the old one.
        let (changed_tx, changed) = mpsc::unbounded_channel();
        let name = local_path.file_name().map(ToOwned::to_owned);
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let Ok(event) = event else { return };
                let ours = event.paths.iter().any(|p| p.file_name() == name.as_deref());
                if ours && !matches!(event.kind, EventKind::Access(_)) {
                    let _ = changed_tx.send(());
                }
            })
            .map_err(|e| EditError::Io(e.to_string()));
        if let Ok(w) = &mut watcher {
            if let Err(e) = w.watch(&dir, RecursiveMode::NonRecursive) {
                watcher = Err(EditError::Io(e.to_string()));
            }
        }
        let opened = watcher.and_then(|w| {
            let opened = self.launch(id, &local_path, options.application)?;
            Ok((w, opened))
        });
        let (watcher, opened) = match opened {
            Ok(result) => result,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(e);
            }
        };

        let (requests, pending) = mpsc::unbounded_channel();
        let conflict_id = Arc::new(AtomicU64::new(0));
        let mut events = EditEvents::default();
        events.subscribe(subscription);
        let events = Arc::new(Mutex::new(events));
        let uploads = tokio::spawn(
            Uploader {
                id,
                target: target.clone(),
                local_path: local_path.clone(),
                revision: Some(download.revision),
                uploaded: download.contents,
                conflict_id: conflict_id.clone(),
                next_conflict: 0,
                debounce: self.debounce,
                events: Arc::clone(&events),
            }
            .run(changed, pending),
        );
        edits.insert(
            id,
            Edit {
                target,
                primary,
                allow_binary: options.allow_binary,
                local_path,
                conflict_id,
                events,
                requests,
                _watcher: watcher,
                uploads,
            },
        );
        Ok(opened)
    }

    fn launch(
        &self,
        id: EditId,
        path: &Path,
        application: Option<&Path>,
    ) -> Result<OpenedEdit, EditError> {
        if let Some(application) = application {
            if self.opener.open_application(path, application).is_ok() {
                return Ok(OpenedEdit {
                    id,
                    application_fallback: false,
                });
            }
        }
        self.opener.open(path).map_err(EditError::Open)?;
        Ok(OpenedEdit {
            id,
            application_fallback: application.is_some(),
        })
    }

    /// The temp file of an open edit.
    pub fn local_path(&self, id: EditId) -> Option<PathBuf> {
        self.lock().get(&id).map(|e| e.local_path.clone())
    }

    /// Uploads the temp file now, e.g. after a failed upload; the outcome
    /// is reported through the edit's events.
    pub fn retry(&self, id: EditId) -> Result<(), EditError> {
        let edits = self.lock();
        let edit = edits.get(&id).ok_or(EditError::NotOpen)?;
        Self::request(edit, UploadRequest::Retry)
    }

    pub fn retry_owned(&self, id: EditId, owner: &EditOwner) -> Result<(), EditError> {
        Self::request(owned_edit(&self.lock(), id, owner)?, UploadRequest::Retry)
    }

    fn request(edit: &Edit, request: UploadRequest) -> Result<(), EditError> {
        edit.requests.send(request).map_err(|_| EditError::NotOpen)
    }

    /// Uploads the latest local save despite the reported conflict.
    pub fn overwrite(&self, id: EditId, conflict_id: u64) -> Result<(), EditError> {
        let edits = self.lock();
        let edit = conflicted_edit(&edits, id, conflict_id)?;
        Self::request(edit, UploadRequest::Overwrite(conflict_id))
    }

    pub fn overwrite_owned(
        &self,
        id: EditId,
        conflict_id: u64,
        owner: &EditOwner,
    ) -> Result<(), EditError> {
        let edits = self.lock();
        owned_edit(&edits, id, owner)?;
        Self::request(
            conflicted_edit(&edits, id, conflict_id)?,
            UploadRequest::Overwrite(conflict_id),
        )
    }

    pub fn release(&self, id: EditId, owner: &EditOwner) {
        let mut edits = self.lock();
        Self::release_locked(&mut edits, id, owner.id);
    }

    pub fn close_owner(&self, owner: &EditOwner) {
        let mut edits = self.lock();
        owner.closed.store(true, Ordering::Relaxed);
        let ids: Vec<_> = edits.keys().copied().collect();
        for id in ids {
            Self::release_locked(&mut edits, id, owner.id);
        }
    }

    fn release_locked(edits: &mut HashMap<EditId, Edit>, id: EditId, owner: Uuid) {
        let Some(edit) = edits.get(&id) else { return };
        let mut events = edit.events.lock().unwrap_or_else(|p| p.into_inner());
        let last_owner = events.sinks.remove(&Some(owner)).is_some() && events.sinks.is_empty();
        drop(events);
        if last_owner {
            Self::discard(edits.remove(&id).expect("the edit is open"));
        }
    }

    /// Stops watching and uploading, and deletes the temp file; `false` if
    /// the edit was not open. A save the editor makes later is not uploaded.
    pub fn close(&self, id: EditId) -> bool {
        let Some(edit) = self.lock().remove(&id) else {
            return false;
        };
        Self::discard(edit);
        true
    }

    fn discard(edit: Edit) {
        edit.uploads.abort();
        if let Some(dir) = edit.local_path.parent() {
            let _ = std::fs::remove_dir_all(dir);
            // The Host's directory, once its last edit is gone.
            if let Some(host_dir) = dir.parent() {
                let _ = std::fs::remove_dir(host_dir);
            }
        }
    }

    /// Closes every edit and deletes the whole temp directory, also what an
    /// earlier run left behind. For app exit.
    pub fn close_all(&self) {
        let ids: Vec<_> = self.lock().keys().copied().collect();
        for id in ids {
            self.close(id);
        }
        // Unlocked and closed first: Windows cannot delete an open file.
        drop(
            self.run_lock
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take(),
        );
        let _ = std::fs::remove_dir_all(&self.root);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<EditId, Edit>> {
        self.edits.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// One edit's upload loop: waits for saves (and retries), lets the file
/// settle for `debounce`, and uploads it if it differs from what the remote
/// file last received.
struct Uploader {
    id: EditId,
    target: Arc<EditTarget>,
    local_path: PathBuf,
    revision: Option<Revision>,
    /// What the remote file holds as far as we know.
    uploaded: Vec<u8>,
    conflict_id: Arc<AtomicU64>,
    next_conflict: u64,
    debounce: Duration,
    events: Arc<Mutex<EditEvents>>,
}

enum UploadRequest {
    Save,
    Retry,
    Overwrite(u64),
}

impl Uploader {
    fn send(&self, event: EditEvent) {
        self.events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .send(event);
    }

    async fn run(
        mut self,
        mut changed: mpsc::UnboundedReceiver<()>,
        mut requests: mpsc::UnboundedReceiver<UploadRequest>,
    ) {
        loop {
            let request = tokio::select! {
                Some(()) = changed.recv() => UploadRequest::Save,
                Some(request) = requests.recv() => request,
                else => return,
            };
            if matches!(request, UploadRequest::Save) {
                // Wait until no change arrived for `debounce`.
                loop {
                    match tokio::time::timeout(self.debounce, changed.recv()).await {
                        Ok(Some(())) => continue,
                        Ok(None) => return,
                        Err(_) => break,
                    }
                }
            }
            self.upload(request).await;
        }
    }

    async fn upload(&mut self, request: UploadRequest) {
        let pending = self.conflict_id.load(Ordering::Relaxed);
        let overwrite = match request {
            UploadRequest::Overwrite(id) if pending == id => true,
            UploadRequest::Overwrite(_) => return,
            _ if pending != 0 => return,
            _ => false,
        };
        let force = !matches!(request, UploadRequest::Save);
        // Missing for a moment while an editor replaces the file; the
        // replacement is another change.
        let contents = match tokio::fs::read(&self.local_path).await {
            Ok(contents) => contents,
            Err(e) => {
                if force {
                    self.upload_failed(&io(e), overwrite);
                }
                return;
            }
        };
        if !force && contents == self.uploaded {
            return;
        }
        let target = self.target.clone();
        let mut writes = target.writes.lock().await;
        self.send(EditEvent::Uploading);
        let remote = match target.revision(*writes).await {
            Ok(revision) => revision,
            Err(e) => {
                self.upload_failed(&e, overwrite);
                return;
            }
        };
        if !overwrite && self.revision != Some(remote) {
            self.conflict(None);
            return;
        }

        match target.fs.write_file(&target.remote_path, &contents).await {
            Ok(()) => {
                log::info!("Remote edit id={} upload result=success", self.id.0);
                *writes += 1;
                // A successful write can change mtime. If the new revision cannot be
                // determined, the next save must ask before writing again.
                self.revision = target
                    .revision(*writes)
                    .await
                    .ok()
                    .filter(|revision| revision.size == contents.len() as u64);
                self.uploaded = contents;
                self.conflict_id.store(0, Ordering::Relaxed);
                self.send(EditEvent::Uploaded);
            }
            Err(e) => self.upload_failed(&e.into(), overwrite),
        }
    }

    fn upload_failed(&mut self, error: &EditError, overwrite: bool) {
        let kind = match error {
            EditError::Fs(e) => e.log_kind(),
            EditError::NotAFile => "notAFile",
            _ => "io",
        };
        log::warn!("Remote edit id={} upload result={kind}", self.id.0);
        if overwrite {
            self.conflict(Some(error.to_string()));
        } else {
            self.send(EditEvent::UploadFailed {
                reason: error.to_string(),
            });
        }
    }

    fn conflict(&mut self, reason: Option<String>) {
        self.next_conflict += 1;
        self.conflict_id
            .store(self.next_conflict, Ordering::Relaxed);
        self.send(EditEvent::Conflict {
            conflict_id: self.next_conflict,
            reason,
        });
    }
}

/// Deletes each run folder under `base` whose lock nobody holds.
fn remove_ended_runs(base: &Path) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let ended = match File::open(dir.join(RUN_LOCK)) {
            // Locked by a live run: `try_lock` fails.
            Ok(lock) => lock.try_lock().is_ok(),
            Err(e) => e.kind() == std::io::ErrorKind::NotFound,
        };
        if ended {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

fn io(e: std::io::Error) -> EditError {
    EditError::Io(e.to_string())
}

/// The last component of a remote path, safe as a local file name.
fn file_name(remote_path: &str) -> String {
    let name = remote_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("");
    match dir_name(name) {
        n if n.is_empty() || n == "." || n == ".." => "file".to_owned(),
        n => n,
    }
}

/// `raw` with characters that are not allowed in a local file name replaced.
fn dir_name(raw: &str) -> String {
    raw.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect()
}
