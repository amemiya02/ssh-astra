//! File panel commands: an SFTP session per File panel, over the Host's
//! existing Connection or a connection opened by the SFTP workspace.

use std::future::Future;
use std::sync::Arc;

use sshastra_core::edit::Opener;
use sshastra_core::files::{
    self, DiskBrowser, FsError, FsId, FsRegistry, FsResult, Listing, NameSearchMode,
    NameSearchResult, OpenRemote, PermissionChange, RemoteFs,
};
use sshastra_core::hosts::HostId;
use sshastra_core::ssh::ConnectionManager;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tokio::sync::oneshot;

use crate::prompts::{ChannelPrompter, PromptRequest};
use crate::windows;

use super::connections::{schedule_os_detection, HostRoute};
use super::edit::SystemOpener;

use crate::error::{CommandError, CommandResult};

/// Opens an SFTP session on `host_id`'s live Connection. Fails with
/// `notConnected` if the Host has none.
#[tauri::command]
pub async fn files_open(
    window: WebviewWindow,
    connections: State<'_, ConnectionManager>,
    registry: State<'_, FsRegistry>,
    host_id: HostId,
) -> CommandResult<FsId> {
    let fs = connections.open_sftp(&host_id).await?;
    track_files(&window, &registry, registry.insert(Arc::new(fs)))
}

/// Opens the workspace's own SFTP session. It holds the connection without a terminal.
#[tauri::command]
pub async fn files_connect(
    window: WebviewWindow,
    registry: State<'_, FsRegistry>,
    host_id: HostId,
    on_prompt: Channel<PromptRequest>,
) -> CommandResult<FsId> {
    let app = window.app_handle();
    let route = HostRoute::lookup(app, &host_id).await?;
    let prompter = Arc::new(ChannelPrompter::new(windows::prompts(&window)?, on_prompt));
    let connection = route.connect(app, prompter, None).await?;
    let fs = connection.open_sftp().await?;
    schedule_os_detection(app, &host_id, &connection);
    track_files(&window, &registry, registry.insert(Arc::new(fs)))
}

#[tauri::command]
pub fn files_local_open(
    window: WebviewWindow,
    registry: State<'_, FsRegistry>,
) -> CommandResult<FsId> {
    let home = window
        .path()
        .home_dir()
        .map_err(|e| FsError::Io(e.to_string()))?;
    track_files(
        &window,
        &registry,
        registry.insert(Arc::new(DiskBrowser::new(home))),
    )
}

#[tauri::command]
pub async fn files_local_delete(app: AppHandle, paths: Vec<String>) -> CommandResult<()> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| FsError::Io(e.to_string()))?;
    let disk = DiskBrowser::new(home);
    for path in paths {
        disk.remove(&path).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn files_local_open_path(path: std::path::PathBuf) -> CommandResult<()> {
    // Pass a native filesystem path to the system's default application.
    Ok(SystemOpener.open(&path).map_err(FsError::Io)?)
}

/// The Host's shared SFTP session on its live Connection
/// (`ConnectionManager::live_sftp`), looked up anew on every call: what
/// transfers and remote edits run on.
pub fn live_sftp(app: AppHandle, host_id: HostId) -> OpenRemote {
    Arc::new(move || {
        let app = app.clone();
        let host_id = host_id.clone();
        Box::pin(async move {
            let session = app.state::<ConnectionManager>().live_sftp(&host_id).await?;
            Ok(session as Arc<dyn RemoteFs>)
        })
    })
}

/// Resolves the home directory over the Host's existing Connection.
#[tauri::command]
pub async fn files_remote_home(
    connections: State<'_, ConnectionManager>,
    host_id: HostId,
) -> CommandResult<String> {
    Ok(connections.live_sftp(&host_id).await?.home().await?)
}

/// Lists a directory: `""`/`~` is home, `~/x` under it; the server resolves
/// the rest. The listing carries the resolved path.
#[tauri::command]
pub async fn files_list(
    registry: State<'_, FsRegistry>,
    id: FsId,
    path: String,
) -> CommandResult<Listing> {
    let fs = registry.get(id).ok_or_else(CommandError::not_open)?;
    Ok(files::browse(fs.as_ref(), &path).await?)
}

/// Creates the directory `path`. Rejects with `alreadyExists` if the name
/// is taken.
#[tauri::command]
pub async fn files_create_dir(
    registry: State<'_, FsRegistry>,
    id: FsId,
    path: String,
) -> CommandResult<()> {
    let fs = registry.get(id).ok_or_else(CommandError::not_open)?;
    Ok(fs.create_dir(&path).await?)
}

/// Creates an empty file at `path`, rejecting with `alreadyExists` if taken.
#[tauri::command]
pub async fn files_create_empty(
    registry: State<'_, FsRegistry>,
    id: FsId,
    path: String,
) -> CommandResult<()> {
    let fs = registry.get(id).ok_or_else(CommandError::not_open)?;
    Ok(fs.create_empty_file(&path).await?)
}

/// Renames `from` to `to`, never replacing an existing `to`
/// (`alreadyExists`).
#[tauri::command]
pub async fn files_rename(
    registry: State<'_, FsRegistry>,
    id: FsId,
    from: String,
    to: String,
) -> CommandResult<()> {
    let fs = registry.get(id).ok_or_else(CommandError::not_open)?;
    Ok(fs.rename(&from, &to).await?)
}

/// Archives direct children of a remote directory into a new tar.gz file.
#[tauri::command]
pub async fn files_compress(
    registry: State<'_, FsRegistry>,
    id: FsId,
    directory: String,
    names: Vec<String>,
    archive: String,
) -> CommandResult<()> {
    let fs = registry.get(id).ok_or_else(CommandError::not_open)?;
    Ok(fs.compress(&directory, &names, &archive).await?)
}

/// Expands a remote archive into a new sibling directory.
#[tauri::command]
pub async fn files_extract_archive(
    registry: State<'_, FsRegistry>,
    id: FsId,
    directory: String,
    archive: String,
) -> CommandResult<()> {
    let fs = registry.get(id).ok_or_else(CommandError::not_open)?;
    Ok(fs.extract_archive(&directory, &archive).await?)
}

/// How many entries deleting `paths` would remove (each path counts itself
/// and, for a directory, everything under it), for the confirmation.
#[tauri::command]
pub async fn files_count(
    registry: State<'_, FsRegistry>,
    id: FsId,
    paths: Vec<String>,
) -> CommandResult<u64> {
    let fs = registry.get(id).ok_or_else(CommandError::not_open)?;
    let mut total = 0;
    for path in &paths {
        total += files::count_tree(fs.as_ref(), path).await?;
    }
    Ok(total)
}

/// Calculates a folder's size. The request ID is sent once cancellation can
/// be delivered, including when the File panel has already asked to cancel.
#[tauri::command]
pub async fn files_folder_size(
    registry: State<'_, FsRegistry>,
    id: FsId,
    path: String,
    on_start: Channel<u64>,
) -> CommandResult<Option<u64>> {
    scan(&registry, id, on_start, |fs, cancelled| async move {
        fs.folder_size(&path, cancelled).await
    })
    .await
}

#[tauri::command]
pub async fn files_search_names(
    registry: State<'_, FsRegistry>,
    id: FsId,
    path: String,
    query: String,
    mode: NameSearchMode,
    on_start: Channel<u64>,
) -> CommandResult<Option<NameSearchResult>> {
    scan(&registry, id, on_start, |fs, cancelled| async move {
        fs.search_names(&path, &query, mode, cancelled).await
    })
    .await
}

async fn scan<T, F>(
    registry: &FsRegistry,
    id: FsId,
    on_start: Channel<u64>,
    run: impl FnOnce(Arc<dyn RemoteFs>, oneshot::Receiver<()>) -> F,
) -> CommandResult<Option<T>>
where
    F: Future<Output = FsResult<Option<T>>>,
{
    let (request, fs, cancelled) = registry.start_scan(id).ok_or_else(CommandError::not_open)?;
    let result = if on_start.send(request).is_ok() {
        run(fs, cancelled).await.map_err(Into::into)
    } else {
        Ok(None)
    };
    registry.cancel_scan(id, request);
    result
}

#[tauri::command]
pub fn files_cancel_scan(registry: State<'_, FsRegistry>, id: FsId, request_id: u64) {
    registry.cancel_scan(id, request_id);
}

/// Deletes `paths`, directories with everything in them; symlinks are
/// deleted, not followed. Stops at the first failure.
#[tauri::command]
pub async fn files_delete(
    registry: State<'_, FsRegistry>,
    id: FsId,
    paths: Vec<String>,
) -> CommandResult<()> {
    let fs = registry.get(id).ok_or_else(CommandError::not_open)?;
    for path in &paths {
        files::remove_tree(fs.as_ref(), path).await?;
    }
    Ok(())
}

/// Changes ownership and permission bits, optionally applying the mode to a folder tree.
#[tauri::command]
pub async fn files_chmod(
    registry: State<'_, FsRegistry>,
    id: FsId,
    path: String,
    change: PermissionChange,
) -> CommandResult<()> {
    let fs = registry.get(id).ok_or_else(CommandError::not_open)?;
    Ok(files::change_permissions(fs.as_ref(), &path, change).await?)
}

/// Closes the SFTP session; closing one that is already gone is fine.
/// Async so the session is dropped on the Tokio runtime, where it closes its
/// channel.
#[tauri::command]
pub async fn files_close(
    window: WebviewWindow,
    registry: State<'_, FsRegistry>,
    id: FsId,
) -> CommandResult<()> {
    let _ = windows::with_resources(&window, |resources| resources.files.remove(&id));
    registry.remove(id);
    Ok(())
}

fn track_files(window: &WebviewWindow, registry: &FsRegistry, id: FsId) -> CommandResult<FsId> {
    if let Err(error) = windows::with_resources(window, |resources| resources.files.insert(id)) {
        registry.remove(id);
        return Err(error);
    }
    Ok(id)
}
