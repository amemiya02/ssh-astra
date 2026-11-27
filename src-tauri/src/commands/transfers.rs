//! Transfer commands: the app's one TransferQueue. Remote endpoints go
//! over a Host's live Connection (never connecting), on its shared SFTP
//! session (`ConnectionManager::live_sftp`), not the File panel's, so
//! browsing is not stuck behind a big file.
//! Every change is pushed to the single channel registered with
//! `transfers_watch`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

mod batches;
use batches::{Summary, TransferBatches};

use super::watch::Watcher;
use sshastra_core::files::{
    ConflictAnswer, DiskFs, RemoteTransfer, Transfer, TransferHost, TransferId, TransferQueue,
    TransferSettings,
};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::error::CommandResult;
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
use crate::transfer_activity::Activity;

use super::files::live_sftp;
use super::notifications::{show_in_background, NotificationLocale};
use super::settings::SettingsState;

/// The TransferQueue and the channel its changes go to.
pub struct TransfersState {
    queue: TransferQueue,
    watcher: Arc<Watcher<Transfer>>,
    batches: Arc<TransferBatches>,
    system_locale: Mutex<NotificationLocale>,
    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    pub(crate) activity: Arc<Activity>,
}

impl TransfersState {
    pub(crate) fn new(app: &AppHandle) -> Self {
        let watcher: Arc<Watcher<Transfer>> = Arc::default();
        let sink = Arc::clone(&watcher);
        #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
        let activity = Activity::start(app);
        #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
        let observe = Arc::clone(&activity);
        let batches = Arc::new(TransferBatches::default());
        let finish = Arc::clone(&batches);
        let app = app.clone();
        let queue = TransferQueue::new(Arc::new(DiskFs), move |transfer| {
            #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
            observe.changed(transfer);
            sink.send(transfer.clone());
            if let Some(summary) = finish.changed(transfer.id, &transfer.state) {
                notify_batch(&app, summary);
            }
        });
        Self {
            queue,
            watcher,
            batches,
            system_locale: Mutex::default(),
            #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
            activity,
        }
    }

    pub(crate) fn unwatch(&self, label: &str) {
        self.watcher.unsubscribe(label);
    }

    fn enqueue(&self, app: &AppHandle, start: impl FnOnce() -> Vec<TransferId>) -> Vec<TransferId> {
        let (ids, summary) = self.batches.track(start);
        if let Some(summary) = summary {
            notify_batch(app, summary);
        }
        ids
    }

    pub fn queue(&self) -> TransferQueue {
        self.queue.clone()
    }

    /// Applies the `transfers` settings section.
    pub fn apply(&self, settings: &TransferSettings) {
        #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
        self.activity.set_prevent_sleep(settings.prevent_sleep);
        self.queue.set_concurrency(settings.concurrency());
    }
}

fn notify_batch(app: &AppHandle, summary: Summary) {
    if cfg!(feature = "e2e") {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let system_locale = *app.state::<TransfersState>().system_locale.lock().unwrap();
        let locale = app
            .state::<SettingsState>()
            .with(|store| {
                let enabled = store
                    .sections()
                    .get("notifications")
                    .and_then(|value| value["transfers"].as_bool())
                    .unwrap_or(true);
                let locale = store
                    .sections()
                    .get("general")
                    .and_then(|value| value["language"].as_str())
                    .and_then(NotificationLocale::named)
                    .unwrap_or(system_locale);
                Ok(enabled.then_some(locale))
            })
            .unwrap_or(Some(system_locale));
        if let Some(locale) = locale {
            let (title, body) =
                locale.transfer_batch(summary.completed, summary.failed, summary.cancelled);
            if let Some(window) = crate::windows::active(&app) {
                show_in_background(window, title, body);
            }
        }
    });
}

/// Sends every later change to `on_event` (replacing that Window’s earlier channel,
/// e.g. after a reload) and returns every transfer now.
#[tauri::command]
pub fn transfers_watch(
    window: WebviewWindow,
    transfers: State<'_, TransfersState>,
    on_event: Channel<Transfer>,
    system_locale: NotificationLocale,
) -> Vec<Transfer> {
    *transfers.system_locale.lock().unwrap() = system_locale;
    transfers
        .watcher
        .subscribe(window.label(), on_event, || transfers.queue.list())
}

/// Queues uploading each local file or folder in `paths` into the remote
/// directory `remote_dir` on `host`.
#[tauri::command]
pub async fn transfers_upload(
    app: AppHandle,
    transfers: State<'_, TransfersState>,
    host: TransferHost,
    paths: Vec<PathBuf>,
    remote_dir: String,
) -> Result<Vec<TransferId>, ()> {
    let open = live_sftp(app.clone(), host.id.clone());
    let target = RemoteTransfer { host, open };
    Ok(transfers.enqueue(&app, || {
        paths
            .into_iter()
            .map(|path| {
                transfers
                    .queue
                    .upload_to(target.clone(), path, remote_dir.clone())
            })
            .collect()
    }))
}

/// Queues downloading each remote file or folder in `paths` (absolute) on
/// `host` into the local directory `local_dir`.
#[tauri::command]
pub async fn transfers_download(
    app: AppHandle,
    transfers: State<'_, TransfersState>,
    host: TransferHost,
    paths: Vec<String>,
    local_dir: PathBuf,
) -> Result<Vec<TransferId>, ()> {
    let open = live_sftp(app.clone(), host.id.clone());
    let source = RemoteTransfer { host, open };
    Ok(transfers.enqueue(&app, || {
        paths
            .into_iter()
            .map(|path| {
                transfers
                    .queue
                    .download_from(source.clone(), path, local_dir.clone())
            })
            .collect()
    }))
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
        open: live_sftp(app.clone(), target.id.clone()),
        host: target,
    };
    Ok(transfers.enqueue(&app, || {
        paths
            .into_iter()
            .map(|path| {
                transfers.queue.copy_remote(
                    source.clone(),
                    path,
                    target.clone(),
                    remote_dir.clone(),
                )
            })
            .collect()
    }))
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

/// Reveals a completed download through the native file manager.
#[tauri::command]
pub async fn transfer_reveal_download(
    transfers: State<'_, TransfersState>,
    id: TransferId,
) -> CommandResult<()> {
    let path = transfers.queue.completed_download_path(id).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "the completed download is unavailable",
        )
    })?;
    tauri::async_runtime::spawn_blocking(move || tauri_plugin_opener::reveal_item_in_dir(path))
        .await
        .map_err(std::io::Error::other)?
        .map_err(std::io::Error::other)?;
    Ok(())
}
