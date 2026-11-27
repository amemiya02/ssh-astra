use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::{executable, file, foreign_entry, identifier, LOGIN_ARG};

pub(super) struct Registration {
    label: String,
    path: PathBuf,
    executable: PathBuf,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "PascalCase")]
struct LaunchAgent {
    label: String,
    program_arguments: [String; 2],
    run_at_load: bool,
    disabled: bool,
    limit_load_to_session_type: String,
    abandon_process_group: bool,
}

impl Registration {
    pub(super) fn new(app: &AppHandle) -> io::Result<Self> {
        let home = app.path().home_dir().map_err(io::Error::other)?;
        let label = identifier(app);
        Ok(Self {
            path: home
                .join("Library/LaunchAgents")
                .join(format!("{label}.plist")),
            label,
            executable: executable(app)?.canonicalize()?,
        })
    }

    fn read(&self) -> io::Result<Option<LaunchAgent>> {
        let Some(bytes) = file::read(&self.path)? else {
            return Ok(None);
        };
        let entry: LaunchAgent = plist::from_bytes(&bytes).map_err(|_| foreign_entry())?;
        if entry.label != self.label || entry.program_arguments[1] != LOGIN_ARG {
            return Err(foreign_entry());
        }
        Ok(Some(entry))
    }

    pub(super) fn enabled(&self) -> io::Result<bool> {
        Ok(self.read()?.is_some_and(|entry| {
            entry.run_at_load
                && !entry.disabled
                && self.executable.to_str() == Some(entry.program_arguments[0].as_str())
        }))
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
        let executable = self.executable.to_str().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "The executable path is not Unicode",
            )
        })?;
        let agent = LaunchAgent {
            label: self.label.clone(),
            program_arguments: [executable.into(), LOGIN_ARG.into()],
            run_at_load: true,
            disabled: false,
            limit_load_to_session_type: "Aqua".into(),
            // Let an updater relaunch into the installed version when this process exits.
            abandon_process_group: true,
        };
        let mut bytes = Vec::new();
        plist::to_writer_xml(&mut bytes, &agent).map_err(io::Error::other)?;
        file::replace(&self.path, &bytes, existing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn launch_agent_round_trips_its_program_and_argument_and_is_removable_when_stale() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("LaunchAgents/dev.sshastra.test.plist");
        let executable = dir.path().join("SSH & Astra <example>/sshastra");
        let mut registration = Registration {
            label: "dev.sshastra.test".into(),
            path,
            executable: executable.clone(),
        };
        assert!(!registration.enabled().unwrap());
        registration.set_enabled(true).unwrap();
        let saved = registration.read().unwrap().unwrap();
        assert_eq!(
            saved.program_arguments,
            [executable.to_str().unwrap(), "--from-login"]
        );
        assert!(saved.run_at_load);
        assert_eq!(saved.limit_load_to_session_type, "Aqua");
        assert!(registration.enabled().unwrap());

        registration.executable = dir.path().join("Other copy/sshastra");
        assert!(!registration.enabled().unwrap());
        registration.set_enabled(false).unwrap();
        assert!(!registration.path.exists());
    }

    #[test]
    fn a_foreign_launch_agent_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("foreign.plist");
        let bytes = b"belongs to another entry";
        fs::write(&path, bytes).unwrap();
        let registration = Registration {
            label: "dev.sshastra.test".into(),
            path: path.clone(),
            executable: dir.path().join("sshastra"),
        };
        assert!(registration.enabled().is_err());
        assert!(registration.set_enabled(true).is_err());
        assert!(registration.set_enabled(false).is_err());
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}
