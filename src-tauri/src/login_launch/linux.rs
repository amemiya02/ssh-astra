use std::io;
use std::path::{Path, PathBuf};

use gtk::glib::{KeyFile, KeyFileFlags};
use tauri::{AppHandle, Manager};

use super::{executable, file, foreign_entry, identifier, LOGIN_ARG};

const GROUP: &str = "Desktop Entry";
const OWNER: &str = "X-SSH-Astra-Login";

pub(super) struct Registration {
    path: PathBuf,
    executable: PathBuf,
}

impl Registration {
    pub(super) fn new(app: &AppHandle) -> io::Result<Self> {
        let config = app.path().config_dir().map_err(io::Error::other)?;
        Ok(Self {
            path: config
                .join("autostart")
                .join(format!("{}.desktop", identifier(app))),
            executable: executable(app)?,
        })
    }

    fn read(&self) -> io::Result<Option<KeyFile>> {
        let Some(bytes) = file::read(&self.path)? else {
            return Ok(None);
        };
        let data = std::str::from_utf8(&bytes).map_err(|_| foreign_entry())?;
        let entry = KeyFile::new();
        entry
            .load_from_data(data, KeyFileFlags::NONE)
            .map_err(|_| foreign_entry())?;
        if !matches!(entry.boolean(GROUP, OWNER), Ok(true)) {
            return Err(foreign_entry());
        }
        Ok(Some(entry))
    }

    pub(super) fn enabled(&self) -> io::Result<bool> {
        let Some(entry) = self.read()? else {
            return Ok(false);
        };
        let expected = exec(&self.executable)?;
        Ok(entry
            .string(GROUP, "Type")
            .is_ok_and(|value| value.as_str() == "Application")
            && entry
                .string(GROUP, "Exec")
                .is_ok_and(|value| value.as_str() == expected)
            && !matches!(entry.boolean(GROUP, "Hidden"), Ok(true))
            && !matches!(entry.boolean(GROUP, "X-GNOME-Autostart-enabled"), Ok(false))
            && self.executable.is_file())
    }

    pub(super) fn set_enabled(&self, enabled: bool) -> io::Result<()> {
        let existing = self.read()?.is_some();
        if !enabled {
            return if existing {
                file::remove(&self.path)
            } else {
                Ok(())
            };
        }
        self.executable.metadata()?;
        let entry = KeyFile::new();
        entry.set_string(GROUP, "Type", "Application");
        entry.set_string(GROUP, "Name", "SSH Astra");
        entry.set_string(GROUP, "Exec", &exec(&self.executable)?);
        entry.set_boolean(GROUP, "Terminal", false);
        entry.set_boolean(GROUP, "StartupNotify", false);
        entry.set_boolean(GROUP, OWNER, true);
        file::replace(&self.path, entry.to_data().as_bytes(), existing)
    }
}

fn exec(path: &Path) -> io::Result<String> {
    let path = path
        .to_str()
        .filter(|path| !path.contains('=') && !path.chars().any(char::is_control))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "The executable path cannot be used in a desktop entry",
            )
        })?;
    // GKeyFile escapes the value for the entry. Here we quote the Exec argument.
    let mut quoted = String::from("\"");
    for ch in path.chars() {
        if matches!(ch, '"' | '`' | '$' | '\\') {
            quoted.push('\\');
        }
        if ch == '%' {
            quoted.push('%');
        }
        quoted.push(ch);
    }
    Ok(format!("{quoted}\" {LOGIN_ARG}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn registration_is_off_until_enabled_and_removable_after_the_app_moves() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("autostart/test.desktop");
        let executable = dir.path().join("SSH Astra \" ` $ \\ %");
        fs::write(&executable, []).unwrap();
        let registration = Registration {
            path: path.clone(),
            executable: executable.clone(),
        };
        assert!(!registration.enabled().unwrap());
        registration.set_enabled(true).unwrap();
        assert!(registration.enabled().unwrap());

        let entry = registration.read().unwrap().unwrap();
        let command = entry.string(GROUP, "Exec").unwrap().replace("%%", "%");
        assert_eq!(
            gtk::glib::shell_parse_argv(command).unwrap(),
            [executable.into_os_string(), LOGIN_ARG.into()]
        );

        let executable = dir.path().join("new-installation");
        fs::write(&executable, []).unwrap();
        let moved = Registration {
            path: path.clone(),
            executable,
        };
        assert!(!moved.enabled().unwrap());
        moved.set_enabled(true).unwrap();
        assert!(moved.enabled().unwrap());
        moved.set_enabled(false).unwrap();
        assert!(!moved.enabled().unwrap());
        assert!(!path.exists());
    }

    #[test]
    fn foreign_entries_and_unreadable_registration_paths_are_reported_without_replacing_them() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("login.desktop");
        let registration = Registration {
            path: path.clone(),
            executable: dir.path().join("sshastra"),
        };
        let contents = b"[Desktop Entry]\nName=Other application\n";
        fs::write(&path, contents).unwrap();
        assert!(registration.enabled().is_err());
        assert!(registration.set_enabled(true).is_err());
        assert!(registration.set_enabled(false).is_err());
        assert_eq!(fs::read(&path).unwrap(), contents);

        let invalid = Registration {
            path: path.join("invalid.desktop"),
            executable: registration.executable,
        };
        assert_eq!(
            invalid.enabled().unwrap_err().kind(),
            io::ErrorKind::NotADirectory
        );
    }
}
