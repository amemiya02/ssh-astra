//! Remote editing commands: a remote file opened in the user's default
//! application, uploaded again on every save (`sshastra_core::edit`).

use std::path::Path;
use std::sync::Arc;

use sshastra_core::edit::{EditEvent, EditId, Opener, RemoteEditor};
use sshastra_core::files::{FileEntry, FileStat, FsError, FsResult, RemoteFs, SftpFs};
use sshastra_core::hosts::HostId;
use sshastra_core::ssh::{BoxFuture, ConnectionManager};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::error::CommandResult;

/// The system's default application for a file.
pub struct SystemOpener;

impl Opener for SystemOpener {
    fn open(&self, path: &Path) -> Result<(), String> {
        tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
    }
}

/// A Host's files over its live Connection, with a new SFTP session for
/// every request. An edit outlives File panel sessions and Connections (the
/// panel closes its session while the Connection is down): after a
/// reconnect, the next save or retry uploads over the new Connection.
/// Saves are rare, so the extra channel per request is cheap.
struct LiveHostFs {
    app: AppHandle,
    host_id: HostId,
}

impl LiveHostFs {
    async fn sftp(&self) -> FsResult<SftpFs> {
        let connections = self.app.state::<ConnectionManager>();
        let connection = connections
            .live(&self.host_id)
            .await
            .ok_or(FsError::NotConnected)?;
        connection.open_sftp().await
    }
}

impl RemoteFs for LiveHostFs {
    fn home(&self) -> BoxFuture<'_, FsResult<String>> {
        Box::pin(async move { self.sftp().await?.home().await })
    }

    fn canonicalize<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<String>> {
        Box::pin(async move { self.sftp().await?.canonicalize(path).await })
    }

    fn list_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<Vec<FileEntry>>> {
        Box::pin(async move { self.sftp().await?.list_dir(path).await })
    }

    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileStat>> {
        Box::pin(async move { self.sftp().await?.stat(path).await })
    }

    fn read_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<Vec<u8>>> {
        Box::pin(async move { self.sftp().await?.read_file(path).await })
    }

    fn write_file<'a>(&'a self, path: &'a str, data: &'a [u8]) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move { self.sftp().await?.write_file(path, data).await })
    }
}

/// Downloads `path` from `host_id` over its live Connection and opens it in
/// the default application. Upload progress (`{ state: "uploading" |
/// "uploaded" | "uploadFailed", reason? }`) goes to `on_event`. Opening a
/// file that is already open shows it again and returns the same id.
#[tauri::command]
pub async fn edit_open(
    app: AppHandle,
    editor: State<'_, RemoteEditor>,
    host_id: HostId,
    path: String,
    on_event: Channel<EditEvent>,
) -> CommandResult<EditId> {
    let fs = Arc::new(LiveHostFs {
        app: app.clone(),
        host_id: host_id.clone(),
    });
    let id = editor
        .open(fs, &host_id, &path, move |event| {
            let _ = on_event.send(event);
        })
        .await?;
    Ok(id)
}

/// Uploads the edit's temp file now (after a failed upload).
#[tauri::command]
pub fn edit_retry(editor: State<'_, RemoteEditor>, id: EditId) -> CommandResult<()> {
    Ok(editor.retry(id)?)
}

/// Stops uploading and deletes the temp file; closing one that is already
/// gone is fine.
#[tauri::command]
pub fn edit_close(editor: State<'_, RemoteEditor>, id: EditId) {
    editor.close(id);
}
