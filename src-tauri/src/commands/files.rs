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

/// Closes the SFTP session; closing one that is already gone is fine.
/// Async so the session is dropped on the Tokio runtime, where it closes its
/// channel.
#[tauri::command]
pub async fn files_close(registry: State<'_, FsRegistry>, id: FsId) -> CommandResult<()> {
    registry.remove(id);
    Ok(())
}
