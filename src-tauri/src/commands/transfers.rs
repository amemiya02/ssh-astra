//! Transfer commands: the app's one TransferQueue. Remote endpoints go
//! over a Host's live Connection (never connecting), on its shared SFTP
//! session (`ConnectionManager::live_sftp`), not the File panel's, so
//! browsing is not stuck behind a big file.
//! Every change is pushed to the single channel registered with
//! `transfers_watch`.

use std::path::PathBuf;
use std::sync::Arc;

use super::watch::Watcher;
use sshastra_core::files::{
    ConflictAnswer, DiskFs, RemoteTransfer, Transfer, TransferHost, TransferId, TransferQueue,
    TransferSettings,
};
use sshastra_core::hosts::HostId;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use super::files::live_sftp;

/// The TransferQueue and the channel its changes go to.
pub struct TransfersState {
    queue: TransferQueue,
    watcher: Arc<Watcher<Transfer>>,
}

impl Default for TransfersState {
    fn default() -> Self {
        let watcher: Arc<Watcher<Transfer>> = Arc::default();
        let sink = Arc::clone(&watcher);
        let queue = TransferQueue::new(Arc::new(DiskFs), move |transfer| {
            sink.send(transfer.clone());
        });
        Self { queue, watcher }
    }
}

impl TransfersState {
    pub fn queue(&self) -> TransferQueue {
        self.queue.clone()
    }

    /// Applies the `transfers` settings section.
    pub fn apply(&self, settings: &TransferSettings) {
        self.queue.set_concurrency(settings.concurrency());
    }
}

/// Sends every later change to `on_event` (replacing any earlier channel,
/// e.g. after a reload) and returns every transfer now.
#[tauri::command]
pub fn transfers_watch(
    transfers: State<'_, TransfersState>,
    on_event: Channel<Transfer>,
) -> Vec<Transfer> {
    transfers
        .watcher
        .subscribe(on_event, || transfers.queue.list())
}

/// Queues uploading each local file or folder in `paths` into the remote
/// directory `remote_dir` on Host `host_id`.
#[tauri::command]
pub async fn transfers_upload(
    app: AppHandle,
    transfers: State<'_, TransfersState>,
    host_id: HostId,
    paths: Vec<PathBuf>,
    remote_dir: String,
) -> Result<Vec<TransferId>, ()> {
    let open = live_sftp(app, host_id.clone());
    Ok(paths
        .into_iter()
        .map(|path| {
            transfers
                .queue
                .upload_to(host_id.clone(), Arc::clone(&open), path, remote_dir.clone())
        })
        .collect())
}

/// Queues downloading each remote file or folder in `paths` (absolute) on
/// Host `host_id` into the local directory `local_dir`.
#[tauri::command]
pub async fn transfers_download(
    app: AppHandle,
    transfers: State<'_, TransfersState>,
    host_id: HostId,
    paths: Vec<String>,
    local_dir: PathBuf,
) -> Result<Vec<TransferId>, ()> {
    let open = live_sftp(app, host_id.clone());
    Ok(paths
        .into_iter()
        .map(|path| {
            transfers.queue.download_from(
                host_id.clone(),
                Arc::clone(&open),
                path,
                local_dir.clone(),
            )
        })
        .collect())
}

/// Queues copying each source path into a directory on another Host.
#[tauri::command]
pub async fn transfers_copy_remote(
    app: AppHandle,
    transfers: State<'_, TransfersState>,
    source: TransferHost,
    paths: Vec<String>,
    target: TransferHost,
    remote_dir: String,
) -> Result<Vec<TransferId>, ()> {
    let source = RemoteTransfer {
        open: live_sftp(app.clone(), source.id.clone()),
        host: source,
    };
    let target = RemoteTransfer {
        open: live_sftp(app, target.id.clone()),
        host: target,
    };
    Ok(paths
        .into_iter()
        .map(|path| {
            transfers
                .queue
                .copy_remote(source.clone(), path, target.clone(), remote_dir.clone())
        })
        .collect())
}

#[tauri::command]
pub fn transfer_cancel(transfers: State<'_, TransfersState>, id: TransferId) {
    transfers.queue.cancel(id);
}

#[tauri::command]
pub fn transfer_pause(transfers: State<'_, TransfersState>, id: TransferId) {
    transfers.queue.pause(id);
}

#[tauri::command]
pub fn transfer_resume(transfers: State<'_, TransfersState>, id: TransferId) {
    transfers.queue.resume(id);
}

#[tauri::command]
pub fn transfer_retry(transfers: State<'_, TransfersState>, id: TransferId) {
    transfers.queue.retry(id);
}

/// Answers a transfer's question about a file that already exists.
#[tauri::command]
pub fn transfer_answer(
    transfers: State<'_, TransfersState>,
    id: TransferId,
    answer: ConflictAnswer,
) {
    transfers.queue.answer(id, answer);
}

/// Forgets finished transfers.
#[tauri::command]
pub fn transfers_remove(transfers: State<'_, TransfersState>, ids: Vec<TransferId>) {
    transfers.queue.remove(&ids);
}
