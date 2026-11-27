//! Command history is local to this app and stored separately from Host exports.

use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::TerminalSettings;
use crate::fs_util::write_atomically_private;
use crate::hosts::{HostId, HostStore};

const MAX_COMMANDS_PER_HOST: usize = 5_000;

pub struct CommandHistory {
    directory: PathBuf,
    /// Serialize the read, update and replace with other writes and clears.
    writes: std::sync::Mutex<()>,
}

impl CommandHistory {
    /// Uses `directory` when recording starts. Opening alone creates nothing.
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            writes: std::sync::Mutex::new(()),
        }
    }

    /// Returns a saved Host's command lines, newest first.
    pub fn list(&self, host: &HostId) -> io::Result<Vec<String>> {
        read(&self.path(host))
    }

    /// Records a Shell integration command line for a saved Host, subject to the current settings.
    pub fn record(
        &self,
        settings: &TerminalSettings,
        hosts: &HostStore,
        host: &HostId,
        command: &str,
    ) -> io::Result<()> {
        if !settings.command_history
            || !settings.shell_integration
            || command.is_empty()
            || command.starts_with(' ')
            || hosts.get(host).is_none()
        {
            return Ok(());
        }

        let _lock = self.writes.lock().unwrap_or_else(|p| p.into_inner());
        let path = self.path(host);
        let mut commands = read(&path)?;
        if commands.first().is_some_and(|latest| latest == command) {
            return Ok(());
        }
        commands.retain(|line| line != command);
        commands.truncate(MAX_COMMANDS_PER_HOST - 1);
        commands.insert(0, command.to_owned());
        let contents = serde_json::to_vec_pretty(&commands).map_err(io::Error::other)?;
        write_atomically_private(&path, &contents)
    }

    /// Removes the saved Host's file. Clearing missing history creates nothing.
    pub fn clear(&self, host: &HostId) -> io::Result<()> {
        let _lock = self.writes.lock().unwrap_or_else(|p| p.into_inner());
        match fs::remove_file(self.path(host)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }

    fn path(&self, host: &HostId) -> PathBuf {
        // Host IDs from old stores can be arbitrary strings. Never use them as path components.
        let mut filename = String::with_capacity(69);
        for byte in Sha256::digest(host.to_string().as_bytes()) {
            write!(filename, "{byte:02x}").expect("writing to a String cannot fail");
        }
        filename.push_str(".json");
        self.directory.join(filename)
    }
}

fn read(path: &Path) -> io::Result<Vec<String>> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    serde_json::from_slice(&contents).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "the Command history file is damaged",
        )
    })
}
