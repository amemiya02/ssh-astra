//! Remote editing commands: a remote file opened in the user's editor and
//! uploaded again on every save (`sshastra_core::edit`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use sshastra_core::edit::{EditEvent, EditId, OpenEditOptions, OpenedEdit, Opener, RemoteEditor};
use sshastra_core::files::LiveHostFs;
use sshastra_core::hosts::HostId;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use super::files::live_sftp;
use super::settings::SettingsState;
use crate::error::CommandResult;

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct FilesSettings {
    remote_edit_application: Option<PathBuf>,
}

/// The desktop file opener for a new or existing edit.
pub struct SystemOpener;

impl Opener for SystemOpener {
    fn open(&self, path: &Path) -> Result<(), String> {
        tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
    }

    fn open_application(&self, path: &Path, application: &Path) -> Result<(), String> {
        if !application.is_absolute() {
            return Err("the application path must be absolute".into());
        }
        let path = std::path::absolute(path).map_err(|e| e.to_string())?;
        open_application(&path, application)
    }
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
fn has_extension(application: &Path, extension: &str) -> bool {
    application
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
}

#[cfg(target_os = "macos")]
fn open_application(path: &Path, application: &Path) -> Result<(), String> {
    if !has_extension(application, "app") || !application.is_dir() {
        return Err("the application bundle is unavailable".into());
    }
    open_with_plugin(path, application)
}

#[cfg(windows)]
fn open_application(path: &Path, application: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};

    // CreateProcess receives the document as one argument. The plugin's Windows
    // explicit-app path forwards a raw parameters string to ShellExecute instead.
    if !has_extension(application, "exe") || !application.is_file() {
        return Err("the application executable is unavailable".into());
    }
    Command::new(application)
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn open_application(path: &Path, application: &Path) -> Result<(), String> {
    use gtk::gio::{prelude::AppInfoExt, AppLaunchContext, DesktopAppInfo, File};

    if !application.is_file() {
        return Err("the application is unavailable".into());
    }
    if has_extension(application, "desktop") {
        let app = DesktopAppInfo::from_filename(application)
            .ok_or("the desktop application is unavailable")?;
        return app
            .launch(&[File::for_path(path)], AppLaunchContext::NONE)
            .map_err(|e| e.to_string());
    }
    open_with_plugin(path, application)
}

#[cfg(not(windows))]
fn open_with_plugin(path: &Path, application: &Path) -> Result<(), String> {
    let application = application.to_str().ok_or("invalid application path")?;
    tauri_plugin_opener::open_path(path, Some(application)).map_err(|e| e.to_string())
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn open_application(path: &Path, application: &Path) -> Result<(), String> {
    if !application.is_file() {
        return Err("the application is unavailable".into());
    }
    open_with_plugin(path, application)
}

/// Downloads `path` from `host_id` over its live Connection and opens it in
/// the chosen or default application. Upload progress (`{ state: "uploading" |
/// "uploaded" | "uploadFailed", reason? }`) goes to `on_event`. Opening a
/// file that is already open shows it again and returns the same id. Only
/// regular files up to 10 MB (`tooLarge`, `notAFile`); one that looks binary
/// fails with `binary` unless `allow_binary`.
#[tauri::command]
pub async fn edit_open(
    app: AppHandle,
    editor: State<'_, RemoteEditor>,
    settings: State<'_, SettingsState>,
    host_id: HostId,
    path: String,
    allow_binary: bool,
    on_event: Channel<EditEvent>,
) -> CommandResult<OpenedEdit> {
    // An edit outlives File panel sessions and Connections: each save goes
    // over whatever Connection the Host has then.
    let fs = Arc::new(LiveHostFs::new(live_sftp(app, host_id.clone())));
    let on_event = move |event| {
        let _ = on_event.send(event);
    };
    let files: FilesSettings = settings
        .with(|store| Ok(store.section("files")))
        .unwrap_or_default();
    let options = OpenEditOptions {
        allow_binary,
        application: files.remote_edit_application.as_deref(),
    };
    Ok(editor
        .open_with(fs, &host_id, &path, options, on_event)
        .await?)
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

#[cfg(test)]
mod tests {
    use super::*;
    use sshastra_core::settings::SettingsStore;

    #[test]
    fn files_settings_load_the_chosen_path_and_default_for_older_settings() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        let mut store = SettingsStore::open(&path).unwrap();
        store
            .set("files", serde_json::json!({ "showHidden": true }))
            .unwrap();
        let files: FilesSettings = store.section("files");
        assert_eq!(files.remote_edit_application, None);

        let application = root.path().join("An Editor");
        store
            .set(
                "files",
                serde_json::json!({ "remoteEditApplication": application }),
            )
            .unwrap();
        let reopened = SettingsStore::open(path).unwrap();
        let files: FilesSettings = reopened.section("files");
        assert_eq!(files.remote_edit_application, Some(application));
    }

    #[test]
    fn a_missing_application_or_relative_program_name_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let document = root.path().join("notes with spaces.txt");
        std::fs::write(&document, "synthetic text").unwrap();
        let missing = root.path().join(if cfg!(windows) {
            "missing.exe"
        } else {
            "missing.app"
        });
        assert!(SystemOpener.open_application(&document, &missing).is_err());
        assert!(SystemOpener
            .open_application(&document, Path::new("editor --flag"))
            .is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_desktop_entry_receives_the_literal_file_argument() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{Duration, Instant};

        let root = tempfile::tempdir().unwrap();
        let document = root.path().join("notes 名 & ' x.txt");
        let desktop_file = root.path().join("Synthetic Editor.desktop");
        let executable = root.path().join("Synthetic Editor");
        let result = document.with_extension("opened");
        std::fs::write(&document, "synthetic text").unwrap();
        std::fs::write(
            &executable,
            "#!/bin/sh\n[ \"$#\" -eq 1 ] || exit 1\nprintf '%s' \"$1\" > \"${1%.txt}.opened\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(
            &desktop_file,
            format!(
                "[Desktop Entry]\nType=Application\nName=Synthetic Editor\nExec=\"{}\" %f\n",
                executable.display()
            ),
        )
        .unwrap();

        SystemOpener
            .open_application(&document, &desktop_file)
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        while std::fs::read_to_string(&result).ok().as_deref() != document.to_str() {
            assert!(
                Instant::now() < deadline,
                "the application did not receive {document:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
