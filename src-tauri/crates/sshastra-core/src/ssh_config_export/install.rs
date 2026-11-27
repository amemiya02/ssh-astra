use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use crate::hosts::Host;
use crate::ssh::ConnectionSettings;
use crate::ssh_config::{split_args, split_line, MAX_INCLUDE_DEPTH};

use super::{generate, ExportReport, UserAliases, HEADER};

const FRAGMENT: &str = "ssh-astra.conf";
pub const INCLUDE_LINE: &str = "Include ssh-astra.conf";

#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error("the OpenSSH configuration changed after its preview")]
    ConfigChanged,
    #[error("the global OpenSSH Include is missing")]
    MissingInclude,
    #[error("the managed file is already included more than once or only conditionally")]
    IncludeConflict,
    #[error("the intended managed file already exists and belongs to the user")]
    FragmentExists,
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl ExportError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ConfigChanged => "configChanged",
            Self::MissingInclude => "missingInclude",
            Self::IncludeConflict => "includeConflict",
            Self::FragmentExists => "fragmentExists",
            Self::Io(_) => "io",
        }
    }
}

/// Approval applies to one snapshot of the main user config. This object is
/// kept in the desktop process, so the webview never receives the user's file.
#[derive(Debug)]
pub struct IncludePlan {
    config: PathBuf,
    directory: Option<PathBuf>,
    snapshot: Snapshot,
    add_include: bool,
}

impl IncludePlan {
    pub fn adds_include(&self) -> bool {
        self.add_include
    }
}

pub struct ConfigExport {
    home: PathBuf,
}

impl ConfigExport {
    pub fn new(home: PathBuf) -> Self {
        Self { home }
    }

    fn config(&self) -> PathBuf {
        self.home.join(".ssh/config")
    }

    fn fragment(&self) -> PathBuf {
        self.home.join(".ssh").join(FRAGMENT)
    }

    /// Reads only. A cancelled preview never creates directories or files.
    pub fn preview(&self) -> Result<IncludePlan, ExportError> {
        let config = self.config();
        let directory = canonical_if_present(&self.home.join(".ssh"))?;
        let snapshot = Snapshot::read(&config)?;
        let add_include = !self.scan(&snapshot)?.installed()?;
        self.owned_fragment()?;
        Ok(IncludePlan {
            config,
            directory,
            snapshot,
            add_include,
        })
    }

    pub fn enable(
        &self,
        plan: IncludePlan,
        hosts: &[Host],
        settings: &ConnectionSettings,
    ) -> Result<ExportReport, ExportError> {
        let config = self.config();
        if plan.config != config
            || plan.directory != canonical_if_present(&self.home.join(".ssh"))?
            || !plan.snapshot.same_as(&Snapshot::read(&config)?)
        {
            return Err(ExportError::ConfigChanged);
        }
        let scan = self.scan(&plan.snapshot)?;
        let installed = scan.installed()?;
        if plan.add_include == installed {
            return Err(ExportError::ConfigChanged);
        }
        let fragment = self.owned_fragment()?;
        let generated = generate(hosts, &UserAliases::new(scan.aliases), settings);
        if plan.add_include {
            let mut contents = INCLUDE_LINE.as_bytes().to_vec();
            let previous = plan.snapshot.bytes();
            let eol = match previous.iter().position(|byte| *byte == b'\n') {
                Some(index) if previous.get(index.wrapping_sub(1)) == Some(&b'\r') => {
                    b"\r\n".as_slice()
                }
                _ => b"\n",
            };
            contents.extend_from_slice(eol);
            contents.extend_from_slice(previous);
            self.create_ssh_dir()?;
            replace_checked(&config, &contents, &plan.snapshot)?;
        } else if !plan.snapshot.same_as(&Snapshot::read(&config)?) {
            return Err(ExportError::ConfigChanged);
        }
        replace_checked(&self.fragment(), generated.text.as_bytes(), &fragment)?;
        Ok(generated.report)
    }

    /// Subsequent syncs only write the managed file. If the user changes or
    /// removes the Include, a new approval is required to edit their config.
    pub fn refresh(
        &self,
        hosts: &[Host],
        settings: &ConnectionSettings,
    ) -> Result<ExportReport, ExportError> {
        let path = self.config();
        let config = Snapshot::read(&path)?;
        let scan = self.scan(&config)?;
        if !scan.installed()? {
            return Err(ExportError::MissingInclude);
        }
        let fragment = self.owned_fragment()?;
        let generated = generate(hosts, &UserAliases::new(scan.aliases), settings);
        if !config.same_as(&Snapshot::read(&path)?) {
            return Err(ExportError::ConfigChanged);
        }
        replace_checked(&self.fragment(), generated.text.as_bytes(), &fragment)?;
        Ok(generated.report)
    }

    /// Clears aliases while leaving the user's Include and config alone.
    pub fn disable(&self) -> Result<(), ExportError> {
        let fragment = self.owned_fragment()?;
        if fragment.metadata.is_some() {
            replace_checked(&self.fragment(), HEADER.as_bytes(), &fragment)?;
        }
        Ok(())
    }

    fn owned_fragment(&self) -> Result<Snapshot, ExportError> {
        let snapshot = Snapshot::read(&self.fragment())?;
        if snapshot.metadata.is_some() && !snapshot.bytes().starts_with(HEADER.as_bytes()) {
            return Err(ExportError::FragmentExists);
        }
        Ok(snapshot)
    }

    fn create_ssh_dir(&self) -> io::Result<()> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(self.home.join(".ssh"))
    }

    fn scan(&self, config: &Snapshot) -> Result<Scan, ExportError> {
        let mut scan = Scan::default();
        self.scan_text(&String::from_utf8_lossy(config.bytes()), true, 0, &mut scan)?;
        Ok(scan)
    }

    fn scan_text(
        &self,
        text: &str,
        unconditional_file: bool,
        depth: usize,
        scan: &mut Scan,
    ) -> io::Result<()> {
        if depth >= MAX_INCLUDE_DEPTH {
            return Err(io::Error::other("OpenSSH Includes are nested too deeply"));
        }
        let mut global = unconditional_file;
        for line in text.lines() {
            let Some((keyword, raw)) = split_line(line) else {
                continue;
            };
            match keyword.as_str() {
                "host" => {
                    let patterns = split_args(raw);
                    global = unconditional_file && patterns.as_slice() == ["*"];
                    scan.aliases.push(patterns);
                }
                "match" => {
                    let args = split_args(raw);
                    global = unconditional_file
                        && args.len() == 1
                        && args[0].eq_ignore_ascii_case("all");
                    for pair in args.windows(2) {
                        if pair[0].eq_ignore_ascii_case("originalhost")
                            || pair[0].eq_ignore_ascii_case("host")
                        {
                            scan.aliases
                                .push(pair[1].split(',').map(str::to_owned).collect());
                        }
                    }
                }
                "include" => {
                    for raw in split_args(raw) {
                        self.scan_include(&raw, global, depth, scan)?;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn scan_include(
        &self,
        raw: &str,
        global: bool,
        depth: usize,
        scan: &mut Scan,
    ) -> io::Result<()> {
        let fragment = self.fragment();
        let home = self
            .home
            .to_str()
            .ok_or_else(|| io::Error::other("OpenSSH home path is not UTF-8"))?;
        let raw = raw.replace("${HOME}", home).replace("%d", home);
        if raw.contains("${") || raw.contains('%') {
            return Err(io::Error::other(
                "cannot resolve a dynamic OpenSSH Include path",
            ));
        }
        let path = if let Some(rest) = raw.strip_prefix("~/") {
            self.home.join(rest)
        } else if raw.starts_with('~') {
            return Err(io::Error::other(
                "cannot resolve an OpenSSH Include for another user",
            ));
        } else {
            self.home.join(".ssh").join(&raw)
        };
        let path: PathBuf = path.components().collect();
        if !raw.contains(['*', '?', '[']) {
            // Resolve an exact path independently of glob syntax. It may
            // already name the fragment through a different spelling.
            if path == fragment
                || path.file_name() == fragment.file_name()
                    && canonical_if_present(path.parent().unwrap_or(&path))?
                        == canonical_if_present(fragment.parent().unwrap_or(&fragment))?
            {
                scan.includes.push(global);
            } else if let Some(included) = canonical_if_present(&path)? {
                if canonical_if_present(&fragment)?.as_ref() == Some(&included) {
                    scan.includes.push(global);
                } else {
                    self.scan_file(&included, global, depth, scan)?;
                }
            }
            return Ok(());
        }

        let pattern = path
            .to_str()
            .ok_or_else(|| io::Error::other("OpenSSH Include path is not UTF-8"))?;
        let options = glob::MatchOptions {
            case_sensitive: !cfg!(windows),
            require_literal_leading_dot: true,
            require_literal_separator: true,
        };
        let matcher = glob::Pattern::new(pattern).map_err(io::Error::other)?;
        let managed = canonical_if_present(&fragment)?;
        let mut counted_managed = false;
        for path in glob::glob_with(pattern, options).map_err(io::Error::other)? {
            let path = path.map_err(io::Error::other)?;
            let Some(included) = canonical_if_present(&path)? else {
                continue;
            };
            if path == fragment || managed.as_ref() == Some(&included) {
                scan.includes.push(global);
                counted_managed = true;
            } else {
                self.scan_file(&included, global, depth, scan)?;
            }
        }
        if !counted_managed && matcher.matches_path_with(&fragment, options) {
            scan.includes.push(global);
        }
        Ok(())
    }

    fn scan_file(
        &self,
        path: &Path,
        global: bool,
        depth: usize,
        scan: &mut Scan,
    ) -> io::Result<()> {
        let file = Snapshot::read(path)?;
        self.scan_text(
            &String::from_utf8_lossy(file.bytes()),
            global,
            depth + 1,
            scan,
        )
    }
}

fn canonical_if_present(path: &Path) -> io::Result<Option<PathBuf>> {
    match fs::canonicalize(path) {
        Ok(path) => Ok(Some(path)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[derive(Default)]
struct Scan {
    aliases: Vec<Vec<String>>,
    includes: Vec<bool>,
}

impl Scan {
    fn installed(&self) -> Result<bool, ExportError> {
        match self.includes.as_slice() {
            [] => Ok(false),
            [true] => Ok(true),
            _ => Err(ExportError::IncludeConflict),
        }
    }
}

#[derive(Debug)]
struct Snapshot {
    bytes: Vec<u8>,
    metadata: Option<fs::Metadata>,
}

impl Snapshot {
    fn read(path: &Path) -> io::Result<Self> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if !metadata.is_file() => {
                Err(io::Error::other("OpenSSH config must be a regular file"))
            }
            Ok(before) => {
                let mut options = fs::OpenOptions::new();
                options.read(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.custom_flags(
                        (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
                    );
                }
                let mut file = options.open(path)?;
                let metadata = file.metadata()?;
                if !same_file(&before, &metadata) {
                    return Err(io::Error::other("OpenSSH config changed while being read"));
                }
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes)?;
                if !same_file(&metadata, &file.metadata()?) {
                    return Err(io::Error::other("OpenSSH config changed while being read"));
                }
                Ok(Self {
                    bytes,
                    metadata: Some(metadata),
                })
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Self {
                bytes: Vec::new(),
                metadata: None,
            }),
            Err(error) => Err(error),
        }
    }

    fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    fn same_as(&self, other: &Self) -> bool {
        self.bytes == other.bytes
            && match (&self.metadata, &other.metadata) {
                (None, None) => true,
                (Some(a), Some(b)) => same_file(a, b),
                _ => false,
            }
    }
}

fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    if !a.is_file()
        || !b.is_file()
        || a.len() != b.len()
        || a.modified().ok() != b.modified().ok()
        || a.permissions() != b.permissions()
    {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev()
            && a.ino() == b.ino()
            && a.uid() == b.uid()
            && a.gid() == b.gid()
            && a.ctime() == b.ctime()
            && a.ctime_nsec() == b.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        a.created().ok() == b.created().ok()
    }
}

fn replace_checked(path: &Path, bytes: &[u8], before: &Snapshot) -> Result<(), ExportError> {
    if !before.same_as(&Snapshot::read(path)?) {
        return Err(ExportError::ConfigChanged);
    }
    if before.metadata.is_some() && before.bytes() == bytes {
        return Ok(());
    }
    let staged = path.with_file_name(format!(".ssh-astra-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&staged)?;
    let result: Result<(), ExportError> = (|| {
        file.write_all(bytes)?;
        if let Some(existing) = &before.metadata {
            #[cfg(unix)]
            {
                use rustix::fs::fchown;
                use rustix::process::{Gid, Uid};
                use std::os::unix::fs::MetadataExt;
                let new = file.metadata()?;
                if (new.uid(), new.gid()) != (existing.uid(), existing.gid()) {
                    fchown(
                        &file,
                        Some(Uid::from_raw(existing.uid())),
                        Some(Gid::from_raw(existing.gid())),
                    )
                    .map_err(io::Error::from)?;
                }
            }
            file.set_permissions(existing.permissions())?;
        }
        file.sync_all()?;
        drop(file);
        if !before.same_as(&Snapshot::read(path)?) {
            return Err(ExportError::ConfigChanged);
        }
        if before.metadata.is_some() {
            replace_existing(&staged, path)?;
        } else {
            // A concurrent first writer keeps its file.
            fs::hard_link(&staged, path).map_err(|error| {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    ExportError::ConfigChanged
                } else {
                    error.into()
                }
            })?;
        }
        Ok(())
    })();
    let _ = fs::remove_file(&staged);
    result
}

#[cfg(not(windows))]
fn replace_existing(staged: &Path, path: &Path) -> io::Result<()> {
    fs::rename(staged, path)
}

#[cfg(windows)]
fn replace_existing(staged: &Path, path: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain([0])
            .collect::<Vec<_>>()
    };
    let path = wide(path);
    let staged = wide(staged);
    // Preserve the original file's security descriptor and attributes.
    let success = unsafe {
        ReplaceFileW(
            path.as_ptr(),
            staged.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
