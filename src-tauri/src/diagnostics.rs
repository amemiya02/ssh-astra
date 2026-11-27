//! Local application log files and diagnostics. Only first-party log targets
//! are accepted because dependency traces can include protocol payloads.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use log::{Level, LevelFilter, Log, Metadata, Record};
use sshastra_core::forward::ForwardKind;
use sshastra_core::hosts::{Host, HostAuth};
use tauri::{AppHandle, Manager};

mod redaction;

const LOG_FILES: usize = 4;
const LOG_FILE_BYTES: u64 = 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024;
const CRASH_FILES: usize = 5;

#[derive(Clone)]
pub(crate) struct Logs(PathBuf);

impl Logs {
    pub(crate) fn new(dir: PathBuf) -> Self {
        Self(dir)
    }

    pub(crate) fn install(&self) -> io::Result<()> {
        self.ensure_directory()?;
        log::set_boxed_logger(Box::new(self.clone())).map_err(io::Error::other)?;
        log::set_max_level(LevelFilter::Info);
        Ok(())
    }

    pub(crate) fn open_directory(&self) -> io::Result<()> {
        self.ensure_directory()?;
        tauri_plugin_opener::open_path(&self.0, None::<&str>).map_err(io::Error::other)
    }

    pub(crate) fn report(&self, app: &AppHandle, hosts: &[Host]) -> io::Result<String> {
        let snapshot = self.snapshot()?;
        let home = app.path().home_dir().ok();
        let mut sensitive = sensitive_host_values(hosts, home.as_deref());
        if let Some(home) = home {
            sensitive.push(home.to_string_lossy().into_owned());
        }
        if let Ok(username) = whoami::username() {
            sensitive.push(username);
        }
        // The retained log may refer to Hosts since renamed or removed.
        // Recover their exact values from the JSON identity record before redacting.
        let mut log = String::with_capacity(snapshot.len());
        for line in snapshot.split_inclusive('\n') {
            if let Some((_, json)) =
                line.split_once(" INFO sshastra_core::ssh connection identity ")
            {
                let Ok(identity) =
                    serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(json)
                else {
                    continue;
                };
                sensitive.extend(
                    identity
                        .values()
                        .filter_map(|value| value.as_str().map(str::to_owned)),
                );
            }
            log.push_str(line);
        }
        let redacted = redaction::redact(&log, sensitive.iter().map(String::as_str))
            .map_err(|_| io::Error::other("could not redact diagnostics"))?;
        Ok(format!(
            "SSH Astra {}\nOS: {}\nArchitecture: {}\n\n{redacted}",
            app.package_info().version,
            std::env::consts::OS,
            std::env::consts::ARCH,
        ))
    }

    fn snapshot(&self) -> io::Result<String> {
        self.ensure_directory()?;
        let mut text = String::new();
        {
            let lock = self.lock(".log.lock")?;
            lock.lock_shared()?;
            for index in (0..LOG_FILES).rev() {
                add_log(&mut text, &self.log_path(index))?;
            }
        }
        let lock = self.lock(".crash.lock")?;
        lock.lock_shared()?;
        for path in self.crash_files()? {
            add_log(&mut text, &path)?;
        }
        Ok(text)
    }

    fn ensure_directory(&self) -> io::Result<()> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&self.0)
    }

    fn lock(&self, name: &str) -> io::Result<File> {
        private_file()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.0.join(name))
    }

    fn log_path(&self, index: usize) -> PathBuf {
        if index == 0 {
            self.0.join("sshastra.log")
        } else {
            self.0.join(format!("sshastra.{index}.log"))
        }
    }

    fn append(&self, line: &[u8]) -> io::Result<()> {
        let lock = self.lock(".log.lock")?;
        lock.lock()?;
        let active = self.log_path(0);
        let size = match fs::metadata(&active) {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error),
        };
        if size + line.len() as u64 > LOG_FILE_BYTES {
            for index in (1..LOG_FILES).rev() {
                match fs::rename(self.log_path(index - 1), self.log_path(index)) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
        }
        private_file()
            .append(true)
            .create(true)
            .open(active)?
            .write_all(line)
    }

    pub(crate) fn install_crash_hook(&self) {
        let logs = self.clone();
        std::panic::set_hook(Box::new(move |info| {
            let location = info.location().map_or_else(
                || "unknown".to_owned(),
                |at| {
                    let path = Path::new(at.file());
                    let source = if path.is_absolute() {
                        path.file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("unknown")
                    } else {
                        at.file()
                    };
                    format!("{source}:{}:{}", at.line(), at.column())
                },
            );
            // Panic payloads may contain arbitrary input, including data from a
            // dependency. Keep the error classification and source location.
            let error = panic_category(info.payload());
            if logs.record_crash(error, &location).is_err() {
                let _ = writeln!(io::stderr(), "SSH Astra {error} at {location}");
            }
        }));
    }

    fn crash_files(&self) -> io::Result<Vec<PathBuf>> {
        let mut reports = fs::read_dir(&self.0)?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(is_crash_filename)
            })
            .collect::<Vec<_>>();
        reports.sort_unstable();
        Ok(reports)
    }

    fn record_crash(&self, error: &str, location: &str) -> io::Result<()> {
        self.ensure_directory()?;
        let lock = self.lock(".crash.lock")?;
        lock.lock()?;
        let reports = self.crash_files()?;
        let remove = (reports.len() + 1).saturating_sub(CRASH_FILES);
        for old in reports.into_iter().take(remove) {
            fs::remove_file(old)?;
        }
        let now = Utc::now();
        let stamp = now.format("%Y%m%dT%H%M%S%.9fZ");
        let path = self
            .0
            .join(format!("crash-{stamp}-{}.log", std::process::id()));
        let mut file = private_file().write(true).create_new(true).open(path)?;
        writeln!(
            file,
            "{} {error} at {location}",
            now.to_rfc3339_opts(SecondsFormat::Millis, true)
        )?;
        file.sync_data()
    }
}

fn add_log(text: &mut String, path: &Path) -> io::Result<()> {
    match fs::read_to_string(path) {
        Ok(log) => {
            if let Some((complete, _)) = log.rsplit_once('\n') {
                text.push_str(complete);
                text.push('\n');
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn sensitive_host_values(hosts: &[Host], home: Option<&Path>) -> Vec<String> {
    let mut values = Vec::new();
    for host in hosts {
        values.extend([
            host.id.to_string(),
            host.name.clone(),
            host.address.clone(),
            host.user.clone(),
        ]);
        if let Some(jump) = &host.jump_host {
            values.push(jump.to_string());
        }
        if let HostAuth::Key { identity_file } = &host.auth {
            values.push(identity_file.to_string_lossy().into_owned());
            if let (Some(home), Ok(relative)) = (home, identity_file.strip_prefix("~")) {
                values.push(home.join(relative).to_string_lossy().into_owned());
            }
        }
        for rule in &host.forwards {
            match &rule.kind {
                ForwardKind::Local {
                    bind_address,
                    remote_host,
                    ..
                } => {
                    values.extend([bind_address.clone(), remote_host.clone()]);
                }
                ForwardKind::Remote {
                    bind_address,
                    local_host,
                    ..
                } => {
                    values.extend([bind_address.clone(), local_host.clone()]);
                }
                ForwardKind::Dynamic { bind_address, .. } => values.push(bind_address.clone()),
            }
        }
    }
    values
}

fn panic_category(payload: &(dyn std::any::Any + Send)) -> &'static str {
    let message = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str));
    match message {
        Some(message) if message.starts_with("index out of bounds:") => {
            "Rust panic (index out of bounds)"
        }
        Some(message) if message.starts_with("assertion failed:") => {
            "Rust panic (assertion failed)"
        }
        Some("called `Option::unwrap()` on a `None` value") => "Rust panic (missing value)",
        Some(message) if message.starts_with("called `Result::unwrap()` on an `Err` value:") => {
            "Rust panic (unhandled error)"
        }
        _ => "Rust panic",
    }
}

impl Log for Logs {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= Level::Info
            && (metadata.target().starts_with("sshastra_core::")
                || metadata.target() == "sshastra_lib"
                || metadata.target().starts_with("sshastra_lib::"))
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let message = record.args().to_string();
        let message = if message.len() <= MAX_LINE_BYTES {
            message.replace(char::is_control, " ")
        } else {
            "omitted oversized log entry".to_owned()
        };
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let line = format!("{now} {} {} {message}\n", record.level(), record.target());
        let _ = self.append(line.as_bytes());
    }

    fn flush(&self) {}
}

fn private_file() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

fn is_crash_filename(name: &str) -> bool {
    name.strip_prefix("crash-")
        .and_then(|name| name.strip_suffix(".log"))
        .and_then(|name| name.rsplit_once('-'))
        .is_some_and(|(stamp, pid)| {
            stamp.len() == 26 && stamp.ends_with('Z') && pid.parse::<u32>().is_ok()
        })
}
