//! Bounded snapshots for imports whose source is a user-selected folder.

use std::io::{self, Read};
use std::path::{Path, PathBuf};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};

const MAX_DEPTH: usize = 16;
const MAX_ENTRIES: usize = 10_000;
const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;

#[derive(Default)]
pub(super) struct FolderSnapshot {
    /// Keys are paths relative to the selected folder.
    pub files: Vec<(PathBuf, Vec<u8>)>,
    pub skipped: Vec<(PathBuf, SkipReason)>,
}

pub(super) enum SkipReason {
    Unreadable,
    Limit,
}

pub(super) fn read_session_folder(
    path: &Path,
    extension: &str,
    ignored_files: &[&str],
) -> io::Result<FolderSnapshot> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "choose an absolute folder path",
        ));
    }
    let root = match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => {
            Dir::open_ambient_dir(parent, ambient_authority())?.open_dir_nofollow(name)?
        }
        _ => Dir::open_ambient_dir(path, ambient_authority())?,
    };
    let mut scan = Scan {
        extension,
        ignored_files,
        snapshot: FolderSnapshot::default(),
        entries_left: MAX_ENTRIES,
        bytes_left: MAX_TOTAL_BYTES,
        exhausted: false,
    };
    scan.walk(&root, Path::new(""), 0)?;
    Ok(scan.snapshot)
}

struct Scan<'a> {
    extension: &'a str,
    ignored_files: &'a [&'a str],
    snapshot: FolderSnapshot,
    entries_left: usize,
    bytes_left: usize,
    exhausted: bool,
}

impl Scan<'_> {
    fn walk(&mut self, dir: &Dir, relative: &Path, depth: usize) -> io::Result<()> {
        let mut names = Vec::new();
        for entry in dir.entries()? {
            if self.entries_left == 0 {
                self.exhaust(relative.to_owned());
                return Ok(());
            }
            self.entries_left -= 1;
            names.push(entry?.file_name());
        }
        names.sort_unstable();
        for name in names {
            if self.exhausted {
                break;
            }
            let path = relative.join(&name);
            let is_session = path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case(self.extension))
                && !name.to_str().is_some_and(|name| {
                    self.ignored_files
                        .iter()
                        .any(|ignored| ignored.eq_ignore_ascii_case(name))
                });
            match dir.symlink_metadata(&name) {
                Ok(metadata) if metadata.is_dir() => {
                    if depth == MAX_DEPTH {
                        self.skip(path, SkipReason::Limit);
                    } else if dir
                        .open_dir_nofollow(&name)
                        .and_then(|child| self.walk(&child, &path, depth + 1))
                        .is_err()
                    {
                        self.skip(path, SkipReason::Unreadable);
                    }
                }
                Ok(metadata) if is_session && metadata.is_file() => {
                    let result = self.read_file(dir, Path::new(&name), metadata.len());
                    match result {
                        Ok(bytes) => self.snapshot.files.push((path, bytes)),
                        Err(reason) => self.skip(path, reason),
                    }
                }
                _ if is_session => self.skip(path, SkipReason::Unreadable),
                _ => {}
            }
        }
        Ok(())
    }

    fn read_file(&mut self, dir: &Dir, name: &Path, length: u64) -> Result<Vec<u8>, SkipReason> {
        if length > MAX_FILE_BYTES as u64 {
            return Err(SkipReason::Limit);
        }
        // The preflight type and length can change before open. Refuse links
        // at open time, use nonblocking mode for FIFOs, and recheck the handle.
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No).nonblock(true);
        let file = dir
            .open_with(name, &options)
            .map_err(|_| SkipReason::Unreadable)?;
        if !file
            .metadata()
            .map_err(|_| SkipReason::Unreadable)?
            .is_file()
        {
            return Err(SkipReason::Unreadable);
        }
        let limit = self.bytes_left.min(MAX_FILE_BYTES);
        let mut bytes = Vec::new();
        let result = file.take(limit as u64 + 1).read_to_end(&mut bytes);
        if bytes.len() > self.bytes_left {
            self.exhausted = true;
            return Err(SkipReason::Limit);
        }
        self.bytes_left -= bytes.len();
        result.map_err(|_| SkipReason::Unreadable)?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err(SkipReason::Limit);
        }
        Ok(bytes)
    }

    fn skip(&mut self, path: PathBuf, reason: SkipReason) {
        self.snapshot.skipped.push((path, reason));
    }

    fn exhaust(&mut self, path: PathBuf) {
        self.exhausted = true;
        self.skip(path, SkipReason::Limit);
    }
}
