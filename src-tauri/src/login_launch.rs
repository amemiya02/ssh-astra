//! Per-user desktop registration and the preference for a hidden login launch.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

use std::ffi::OsStr;
use std::io;
use std::path::PathBuf;

use serde_json::{json, Value};
use sshastra_core::settings::SettingsStore;
use tauri::{AppHandle, Manager};

use crate::commands::settings::SettingsState;
use crate::error::CommandResult;

#[cfg(target_os = "linux")]
use linux::Registration;
#[cfg(target_os = "macos")]
use macos::Registration;
#[cfg(windows)]
use windows::Registration;

pub(crate) const SECTION: &str = "loginLaunch";
pub(crate) const PREFERENCES: &str = "loginLaunchPreferences";
const LOGIN_ARG: &str = "--from-login";

pub(crate) fn requested(args: impl IntoIterator<Item = impl AsRef<OsStr>>) -> bool {
    let mut args = args.into_iter().skip(1);
    args.next().is_some_and(|arg| arg.as_ref() == LOGIN_ARG) && args.next().is_none()
}

fn executable(app: &AppHandle) -> io::Result<PathBuf> {
    // Use the installed AppImage, since current_exe points into its temporary mount.
    #[cfg(target_os = "linux")]
    if let Some(path) = app.env().appimage {
        return Ok(path.into());
    }
    let _ = app;
    std::env::current_exe()
}

fn identifier(app: &AppHandle) -> String {
    format!("{}.login", app.config().identifier)
}

fn start_in_tray(store: &SettingsStore) -> bool {
    store
        .sections()
        .get(PREFERENCES)
        .and_then(|value| value.get("startInTray"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub(crate) fn status(app: &AppHandle) -> Value {
    let enabled = Registration::new(app)
        .and_then(|registration| registration.enabled())
        .inspect_err(|error| log::debug!("Could not read the login registration: {error}"))
        .ok();
    json!({ "enabled": enabled })
}

pub(crate) fn set_enabled(app: &AppHandle, value: &Value) -> CommandResult<Value> {
    let enabled = boolean(value, "enabled")?;
    Registration::new(app)?.set_enabled(enabled)?;
    Ok(json!({ "enabled": enabled }))
}

pub(crate) fn set_preferences(store: &mut SettingsStore, value: &Value) -> CommandResult<Value> {
    let value = json!({ "startInTray": boolean(value, "startInTray")? });
    store.set(PREFERENCES, value.clone())?;
    Ok(value)
}

fn boolean(value: &Value, key: &str) -> io::Result<bool> {
    value.get(key).and_then(Value::as_bool).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected a boolean login setting",
        )
    })
}

pub(crate) fn should_hide(app: &AppHandle) -> bool {
    requested(std::env::args_os())
        && app
            .state::<SettingsState>()
            .with(|store| Ok(start_in_tray(store)))
            .unwrap_or(false)
        && Registration::new(app)
            .and_then(|registration| registration.enabled())
            .unwrap_or(false)
        && tauri::async_runtime::block_on(crate::tray::can_restore_at_login(app))
}

fn optional<T>(value: io::Result<T>) -> io::Result<Option<T>> {
    match value {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn foreign_entry() -> io::Error {
    io::Error::new(
        io::ErrorKind::AlreadyExists,
        "The login registration is occupied by another entry",
    )
}

#[cfg(unix)]
mod file {
    use std::fs;
    use std::io::{self, Write};
    use std::path::Path;

    pub(super) fn read(path: &Path) -> io::Result<Option<Vec<u8>>> {
        let Some(metadata) = super::optional(fs::symlink_metadata(path))? else {
            return Ok(None);
        };
        if !metadata.is_file() {
            return Err(super::foreign_entry());
        }
        super::optional(fs::read(path))
    }

    pub(super) fn replace(path: &Path, bytes: &[u8], replacing: bool) -> io::Result<()> {
        let dir = path
            .parent()
            .expect("login registration has a parent directory");
        fs::create_dir_all(dir)?;
        let mut file = tempfile::NamedTempFile::new_in(dir)?;
        file.write_all(bytes)?;
        file.as_file().sync_all()?;
        if replacing {
            file.persist(path)?;
        } else {
            file.persist_noclobber(path)?;
        }
        Ok(())
    }

    pub(super) fn remove(path: &Path) -> io::Result<()> {
        super::optional(fs::remove_file(path)).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_requires_its_exact_argument_and_never_accompanies_a_link() {
        assert!(requested(["sshastra", "--from-login"]));
        assert!(!requested(["sshastra"]));
        assert!(!requested(["sshastra", "--from-login-extra"]));
        assert!(!requested([
            "sshastra",
            "--from-login",
            "ssh://user@example.test"
        ]));
    }

    #[test]
    fn existing_and_malformed_tray_preferences_do_not_enable_hidden_launch() {
        let path = tempfile::tempdir().unwrap();
        let mut store = SettingsStore::open(path.path().join("settings.json")).unwrap();
        assert!(!start_in_tray(&store));
        store
            .set(PREFERENCES, json!({"startInTray": "true"}))
            .unwrap();
        assert!(!start_in_tray(&store));
        set_preferences(&mut store, &json!({"startInTray": true})).unwrap();
        let store = SettingsStore::open(path.path().join("settings.json")).unwrap();
        assert!(start_in_tray(&store));
    }

    #[test]
    fn tray_preference_write_errors_leave_the_loaded_preference_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut store = SettingsStore::open(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(set_preferences(&mut store, &json!({"startInTray": true})).is_err());
        assert!(!start_in_tray(&store));
    }
}
