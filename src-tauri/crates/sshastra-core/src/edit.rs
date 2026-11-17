//! Remote editing: a remote file is downloaded to a temp file, opened in the
//! user's own editor (the system default application), and uploaded again
//! each time it is saved there.
//!
//! [`RemoteEditor`] owns every open edit. Temp files live under its root, one
//! directory per Host (`<root>/<host id>/<edit id>/<file name>`), and are
//! deleted when the edit is closed ([`RemoteEditor::close`]) or the app exits
//! ([`RemoteEditor::close_all`]).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::files::{FsError, RemoteFs};
use crate::hosts::HostId;

/// Opens a local file in the user's default application for it. The app
/// uses the system opener; tests record the call.
pub trait Opener: Send + Sync {
    fn open(&self, path: &Path) -> Result<(), String>;
}

/// Identifies an open edit across the IPC boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EditId(u64);

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
}

/// How long the file must stay unchanged after a save before it is
/// uploaded: editors often write a file in several steps.
const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(500);

struct Edit {
    host_id: HostId,
    remote_path: String,
    local_path: PathBuf,
    /// Asks the upload task to upload now ([`RemoteEditor::retry`]).
    retry: mpsc::UnboundedSender<()>,
    /// Stops watching when dropped.
    _watcher: RecommendedWatcher,
    uploads: JoinHandle<()>,
}

/// Every open remote edit.
pub struct RemoteEditor {
    root: PathBuf,
    opener: Arc<dyn Opener>,
    debounce: Duration,
    next_id: AtomicU64,
    edits: Mutex<HashMap<EditId, Edit>>,
}

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
        }
    }

    pub fn with_debounce(mut self, debounce: Duration) -> Self {
        self.debounce = debounce;
        self
    }

    /// Downloads `remote_path` from `fs` and opens it in the editor; each
    /// later save is uploaded through `fs`, reported to `on_event`.
    pub async fn open(
        &self,
        fs: Arc<dyn RemoteFs>,
        host_id: &HostId,
        remote_path: &str,
        on_event: impl Fn(EditEvent) + Send + Sync + 'static,
    ) -> Result<EditId, EditError> {
        // Already open: show it again rather than download over unsaved or
        // not yet uploaded changes.
        let open = self
            .lock()
            .iter()
            .find(|(_, e)| &e.host_id == host_id && e.remote_path == remote_path)
            .map(|(id, e)| (*id, e.local_path.clone()));
        if let Some((id, local_path)) = open {
            self.opener.open(&local_path).map_err(EditError::Open)?;
            return Ok(id);
        }

        let contents = fs.read_file(remote_path).await?;
        let id = EditId(self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let dir = self
            .root
            .join(dir_name(&host_id.to_string()))
            .join(id.0.to_string());
        let local_path = dir.join(file_name(remote_path));
        std::fs::create_dir_all(&dir).map_err(io)?;
        std::fs::write(&local_path, &contents).map_err(io)?;

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
            self.opener.open(&local_path).map_err(EditError::Open)?;
            Ok(w)
        });
        let watcher = match opened {
            Ok(w) => w,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(e);
            }
        };

        let (retry, retries) = mpsc::unbounded_channel();
        let uploads = tokio::spawn(
            Uploader {
                fs,
                remote_path: remote_path.to_owned(),
                local_path: local_path.clone(),
                uploaded: contents,
                debounce: self.debounce,
                on_event: Box::new(on_event),
            }
            .run(changed, retries),
        );
        self.lock().insert(
            id,
            Edit {
                host_id: host_id.clone(),
                remote_path: remote_path.to_owned(),
                local_path,
                retry,
                _watcher: watcher,
                uploads,
            },
        );
        Ok(id)
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
        edit.retry.send(()).map_err(|_| EditError::NotOpen)
    }

    /// Stops watching and uploading, and deletes the temp file; `false` if
    /// the edit was not open. A save the editor makes later is not uploaded.
    pub fn close(&self, id: EditId) -> bool {
        let Some(edit) = self.lock().remove(&id) else {
            return false;
        };
        edit.uploads.abort();
        if let Some(dir) = edit.local_path.parent() {
            let _ = std::fs::remove_dir_all(dir);
            // The Host's directory, once its last edit is gone.
            if let Some(host_dir) = dir.parent() {
                let _ = std::fs::remove_dir(host_dir);
            }
        }
        true
    }

    /// Closes every edit and deletes the whole temp directory, also what an
    /// earlier run left behind. For app exit.
    pub fn close_all(&self) {
        let ids: Vec<_> = self.lock().keys().copied().collect();
        for id in ids {
            self.close(id);
        }
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
    fs: Arc<dyn RemoteFs>,
    remote_path: String,
    local_path: PathBuf,
    /// What the remote file holds as far as we know.
    uploaded: Vec<u8>,
    debounce: Duration,
    on_event: Box<dyn Fn(EditEvent) + Send + Sync>,
}

impl Uploader {
    async fn run(
        mut self,
        mut changed: mpsc::UnboundedReceiver<()>,
        mut retries: mpsc::UnboundedReceiver<()>,
    ) {
        loop {
            let force = tokio::select! {
                Some(()) = changed.recv() => false,
                Some(()) = retries.recv() => true,
                else => return,
            };
            if !force {
                // Wait until no change arrived for `debounce`.
                loop {
                    match tokio::time::timeout(self.debounce, changed.recv()).await {
                        Ok(Some(())) => continue,
                        Ok(None) => return,
                        Err(_) => break,
                    }
                }
            }
            self.upload(force).await;
        }
    }

    async fn upload(&mut self, force: bool) {
        // Missing for a moment while an editor replaces the file; the
        // replacement is another change.
        let Ok(contents) = tokio::fs::read(&self.local_path).await else {
            return;
        };
        if !force && contents == self.uploaded {
            return;
        }
        (self.on_event)(EditEvent::Uploading);
        match self.fs.write_file(&self.remote_path, &contents).await {
            Ok(()) => {
                self.uploaded = contents;
                (self.on_event)(EditEvent::Uploaded);
            }
            Err(e) => (self.on_event)(EditEvent::UploadFailed {
                reason: e.to_string(),
            }),
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
