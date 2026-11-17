//! Remote editing commands: a remote file opened in the user's default
//! application, uploaded again on every save (`sshastra_core::edit`).

use std::path::Path;
use std::sync::Arc;

use sshastra_core::edit::{EditEvent, EditId, Opener, RemoteEditor};
use sshastra_core::files::LiveHostFs;
use sshastra_core::hosts::HostId;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use super::files::live_sftp;
use crate::error::CommandResult;

/// The system's default application for a file.
pub struct SystemOpener;

impl Opener for SystemOpener {
    fn open(&self, path: &Path) -> Result<(), String> {
        tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
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
    // An edit outlives File panel sessions and Connections: each save goes
    // over whatever Connection the Host has then.
    let fs = Arc::new(LiveHostFs::new(live_sftp(app, host_id.clone())));
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
