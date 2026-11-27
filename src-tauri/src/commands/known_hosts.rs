use serde::Serialize;
use sshastra_core::known_hosts::{KnownHostEntry, KnownHosts};
use tauri::State;

use crate::error::CommandResult;

#[derive(Serialize)]
pub struct KnownHostsSnapshot {
    path: Option<String>,
    entries: Option<Vec<KnownHostEntry>>,
    windows: bool,
}

#[tauri::command]
pub async fn known_hosts_list(
    known_hosts: State<'_, KnownHosts>,
) -> CommandResult<KnownHostsSnapshot> {
    let known_hosts = known_hosts.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        Ok(KnownHostsSnapshot {
            path: known_hosts.user_file().to_str().map(str::to_owned),
            entries: known_hosts.list_user_entries()?,
            windows: cfg!(windows),
        })
    })
    .await
    .map_err(std::io::Error::other)?;
    result
}

#[tauri::command]
pub async fn known_hosts_reveal(known_hosts: State<'_, KnownHosts>) -> CommandResult<()> {
    let path = known_hosts.user_file().to_owned();
    tauri::async_runtime::spawn_blocking(move || tauri_plugin_opener::reveal_item_in_dir(path))
        .await
        .map_err(std::io::Error::other)?
        .map_err(std::io::Error::other)?;
    Ok(())
}
