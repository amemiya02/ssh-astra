use std::io;
use std::path::PathBuf;

use tauri::AppHandle;
use winreg::enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE};
use winreg::RegKey;

use super::{executable, foreign_entry, identifier, optional, LOGIN_ARG};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

pub(super) struct Registration {
    name: String,
    executable: PathBuf,
}

impl Registration {
    pub(super) fn new(app: &AppHandle) -> io::Result<Self> {
        Ok(Self {
            name: identifier(app),
            executable: executable(app)?,
        })
    }

    fn read(&self) -> io::Result<Option<String>> {
        let user = RegKey::predef(HKEY_CURRENT_USER);
        let Some(key) = optional(user.open_subkey_with_flags(RUN_KEY, KEY_QUERY_VALUE))? else {
            return Ok(None);
        };
        let command: Option<String> = optional(key.get_value(&self.name))?;
        if command.as_ref().is_some_and(|command| {
            command
                .strip_prefix('"')
                .and_then(|command| command.split_once("\" "))
                .is_none_or(|(path, arg)| {
                    !std::path::Path::new(path).is_absolute() || arg != LOGIN_ARG
                })
        }) {
            return Err(foreign_entry());
        }
        Ok(command)
    }

    fn command(&self) -> io::Result<String> {
        let path = self.executable.to_str().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "The executable path is not Unicode",
            )
        })?;
        let command = format!("\"{path}\" {LOGIN_ARG}");
        if command.encode_utf16().count() > 260 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "The login command exceeds the Windows Run entry limit",
            ));
        }
        Ok(command)
    }

    pub(super) fn enabled(&self) -> io::Result<bool> {
        let Some(command) = self.read()? else {
            return Ok(false);
        };
        Ok(command == self.command()?)
    }

    pub(super) fn set_enabled(&self, enabled: bool) -> io::Result<()> {
        let existing = self.read()?;
        let user = RegKey::predef(HKEY_CURRENT_USER);
        if enabled {
            let command = self.command()?;
            if existing.as_ref() != Some(&command) {
                let (key, _) = user.create_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)?;
                key.set_value(&self.name, &command)?;
            }
        } else if existing.is_some() {
            if let Some(key) = optional(user.open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE))? {
                optional(key.delete_value(&self.name))?;
            }
        }
        Ok(())
    }
}
