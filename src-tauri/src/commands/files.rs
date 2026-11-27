//! File panel commands: an SFTP session per File panel, over the Host's
//! existing Connection or a connection opened by the SFTP workspace.

use std::sync::Arc;

use sshastra_core::edit::Opener;
use sshastra_core::files::{
    self, DiskBrowser, FsError, FsId, FsRegistry, Listing, OpenRemote, PermissionChange, RemoteFs,
};
use sshastra_core::hosts::HostId;
use sshastra_core::ssh::ConnectionManager;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::prompts::{ChannelPrompter, PendingPrompts, PromptRequest};

use super::connections::connect_host;
use super::edit::SystemOpener;
use super::hosts::HostsState;

use crate::error::{CommandError, CommandResult};

/// Opens an SFTP session on `host_id`'s live Connection. Fails with
/// `notConnected` if the Host has none.
#[tauri::command]
pub async fn files_open(
    connections: State<'_, ConnectionManager>,
    registry: State<'_, FsRegistry>,
    host_id: HostId,
) -> CommandResult<FsId> {
    let fs = connections.open_sftp(&host_id).await?;
    Ok(registry.insert(Arc::new(fs)))
}

/// Opens the workspace's own SFTP session. It holds the connection without a terminal.
#[tauri::command]
pub async fn files_connect(
    app: AppHandle,
    hosts: State<'_, HostsState>,
    pending: State<'_, Arc<PendingPrompts>>,
    registry: State<'_, FsRegistry>,
    host_id: HostId,
    on_prompt: Channel<PromptRequest>,
) -> CommandResult<FsId> {
    let mut hops = hosts.with(|store| Ok(store.jump_chain(&host_id)?))?;
    let host = hops.pop().expect("a jump chain ends with the Host itself");
    let prompter = Arc::new(ChannelPrompter {
        pending: Arc::clone(&pending),
        channel: on_prompt,
    });
    let connection = connect_host(&app, &hops, &host, prompter).await?;
    Ok(registry.insert(Arc::new(connection.open_sftp().await?)))
}

#[tauri::command]
pub fn files_local_open(app: AppHandle, registry: State<'_, FsRegistry>) -> CommandResult<FsId> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| FsError::Io(e.to_string()))?;
    Ok(registry.insert(Arc::new(DiskBrowser::new(home))))
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
    let (request, fs, cancelled) = registry
        .start_folder_size(id)
        .ok_or_else(CommandError::not_open)?;
    let result = if on_start.send(request).is_ok() {
        fs.folder_size(&path, cancelled).await.map_err(Into::into)
    } else {
        Ok(None)
    };
    registry.cancel_folder_size(id, request);
    result
}

#[tauri::command]
pub fn files_cancel_folder_size(registry: State<'_, FsRegistry>, id: FsId, request_id: u64) {
    registry.cancel_folder_size(id, request_id);
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
pub async fn files_close(registry: State<'_, FsRegistry>, id: FsId) -> CommandResult<()> {
    registry.remove(id);
    Ok(())
}
