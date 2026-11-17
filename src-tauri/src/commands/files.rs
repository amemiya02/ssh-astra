//! File panel commands: an SFTP session per File panel, over the Host's
//! existing Connection (the one its Terminal opened). These never connect.

use std::sync::Arc;

use sshastra_core::files::{self, FsError, FsId, FsRegistry, Listing};
use sshastra_core::hosts::HostId;
use sshastra_core::ssh::ConnectionManager;
use tauri::State;

use crate::error::{CommandError, CommandResult};

/// Opens an SFTP session on `host_id`'s live Connection. Fails with
/// `notConnected` if the Host has none.
#[tauri::command]
pub async fn files_open(
    connections: State<'_, ConnectionManager>,
    registry: State<'_, FsRegistry>,
    host_id: HostId,
) -> CommandResult<FsId> {
    let connection = connections
        .live(&host_id)
        .await
        .ok_or(FsError::NotConnected)?;
    let fs = connection.open_sftp().await?;
    Ok(registry.insert(Arc::new(fs)))
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

/// Sets the permission bits (`0o755`) of `path`.
#[tauri::command]
pub async fn files_chmod(
    registry: State<'_, FsRegistry>,
    id: FsId,
    path: String,
    mode: u32,
) -> CommandResult<()> {
    let fs = registry.get(id).ok_or_else(CommandError::not_open)?;
    Ok(fs.set_permissions(&path, mode).await?)
}

/// Closes the SFTP session; closing one that is already gone is fine.
/// Async so the session is dropped on the Tokio runtime, where it closes its
/// channel.
#[tauri::command]
pub async fn files_close(registry: State<'_, FsRegistry>, id: FsId) -> CommandResult<()> {
    registry.remove(id);
    Ok(())
}
