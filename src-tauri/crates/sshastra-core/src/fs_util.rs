//! File helpers shared by the stores (HostStore, SettingsStore).

use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::time::Duration;

/// Writes a sibling temp file, flushes it to disk, then renames it over
/// `path`: readers see either the old file or the new one, never a mix.
pub(crate) fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_atomically_with(
        path,
        bytes,
        fs::OpenOptions::new().write(true).create_new(true),
    )
}

/// Atomic replacement for files containing private user data.
pub(crate) fn write_atomically_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    write_atomically_with(path, bytes, &options)
}

fn write_atomically_with(path: &Path, bytes: &[u8], options: &fs::OpenOptions) -> io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));

    let mut file = options.open(&tmp)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        rename_replacing(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// `fs::rename`, retried briefly: on Windows a reader holding the target open
/// can make the replace fail with "access denied" for a moment.
fn rename_replacing(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempts = 0;
    loop {
        match fs::rename(from, to) {
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied && attempts < 20 => {
                attempts += 1;
                std::thread::sleep(Duration::from_millis(10));
            }
            other => return other,
        }
    }
}
