//! KnownHosts: server identities the user has accepted, kept in OpenSSH's own
//! `known_hosts` format so sshastra and the `ssh` command line trust the same
//! hosts.
//!
//! Reading follows OpenSSH: hashed host names (`|1|salt|hash`), `[host]:port`
//! for non-22 ports, comma-separated patterns with `*`/`?` and `!` negation,
//! `@revoked` lines. `@cert-authority` lines are not host keys and are ignored.
//! Accepting a host appends a plain (unhashed) line to the user's file.

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use russh::keys::{HashAlg, PublicKey};
use sha1::Sha1;

/// A server's public host key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKey(PublicKey);

impl HostKey {
    /// Parses `"<algorithm> <base64> [comment]"`, as in a `.pub` file.
    pub fn from_openssh(line: &str) -> Result<Self, KnownHostsError> {
        PublicKey::from_openssh(line.trim())
            .map(Self)
            .map_err(|e| KnownHostsError::InvalidKey(e.to_string()))
    }

    /// `SHA256:…`, the form `ssh` and `ssh-keygen -l` print.
    pub fn fingerprint(&self) -> String {
        self.0.fingerprint(HashAlg::Sha256).to_string()
    }

    /// For example `ssh-ed25519`.
    pub fn algorithm(&self) -> String {
        self.0.algorithm().as_str().to_owned()
    }

    /// `"<algorithm> <base64>"`, without a comment.
    pub fn to_openssh(&self) -> String {
        let full = self.0.to_openssh().unwrap_or_default();
        full.split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn same_key(&self, other: &HostKey) -> bool {
        self.0.key_data() == other.0.key_data()
    }
}

impl From<PublicKey> for HostKey {
    fn from(key: PublicKey) -> Self {
        Self(key)
    }
}

/// The outcome of checking a server's key against the known hosts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// A recorded key for this host equals the server's key.
    Match,
    /// No key of this type is recorded for this host: ask the user.
    Unknown,
    /// A different key of the same type is recorded: possibly an attack.
    /// The connection must be refused.
    Mismatch(KnownHost),
    /// The key is listed as `@revoked`. The connection must be refused.
    Revoked,
}

/// Where the previously recorded key lives, so the user can fix it by hand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownHost {
    pub fingerprint: String,
    pub path: PathBuf,
    /// 1-based line number in `path`.
    pub line: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum KnownHostsError {
    #[error("could not access {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("invalid public key: {0}")]
    InvalidKey(String),
}

/// The user's `known_hosts` file (read and appended to), plus any system-wide
/// files (read only).
#[derive(Debug, Clone)]
pub struct KnownHosts {
    user_file: PathBuf,
    global_files: Vec<PathBuf>,
}

impl KnownHosts {
    pub fn new(user_file: impl Into<PathBuf>) -> Self {
        Self {
            user_file: user_file.into(),
            global_files: Vec::new(),
        }
    }

    /// The files `ssh` uses by default: `~/.ssh/known_hosts`, and
    /// `/etc/ssh/ssh_known_hosts` on Unix. `None` when there is no home dir.
    pub fn system_default() -> Option<Self> {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
        let kh = Self::new(PathBuf::from(home).join(".ssh").join("known_hosts"));
        Some(if cfg!(unix) {
            kh.with_global_file("/etc/ssh/ssh_known_hosts")
        } else {
            kh
        })
    }

    /// Also trust keys from `path`, without ever writing to it.
    pub fn with_global_file(mut self, path: impl Into<PathBuf>) -> Self {
        self.global_files.push(path.into());
        self
    }

    pub fn user_file(&self) -> &Path {
        &self.user_file
    }

    pub fn verify(&self, host: &str, port: u16, key: &HostKey) -> Result<Verdict, KnownHostsError> {
        let name = lookup_name(host, port);
        let mut mismatch = None;
        let mut matched = false;

        for path in std::iter::once(&self.user_file).chain(&self.global_files) {
            let Some(contents) = read_optional(path)? else {
                continue;
            };
            for (index, line) in contents.lines().enumerate() {
                let Some(entry) = Entry::parse(line) else {
                    continue;
                };
                if !entry.matches_host(&name) {
                    continue;
                }
                match entry.marker {
                    Marker::CertAuthority => {}
                    Marker::Revoked if entry.key.same_key(key) => return Ok(Verdict::Revoked),
                    Marker::Revoked => {}
                    Marker::None if entry.key.same_key(key) => matched = true,
                    Marker::None if entry.key.algorithm() == key.algorithm() => {
                        mismatch.get_or_insert_with(|| KnownHost {
                            fingerprint: entry.key.fingerprint(),
                            path: path.clone(),
                            line: index + 1,
                        });
                    }
                    Marker::None => {}
                }
            }
        }

        Ok(if matched {
            Verdict::Match
        } else if let Some(known) = mismatch {
            Verdict::Mismatch(known)
        } else {
            Verdict::Unknown
        })
    }

    /// Records `key` for `host:port` in the user's file, creating it (and
    /// `~/.ssh`) if needed.
    pub fn accept(&self, host: &str, port: u16, key: &HostKey) -> Result<(), KnownHostsError> {
        let path = &self.user_file;
        let io_err = |source| KnownHostsError::Io {
            path: path.clone(),
            source,
        };
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            if !dir.exists() {
                create_private_dir(dir).map_err(io_err)?;
            }
        }

        let needs_newline = match read_optional(path)? {
            Some(existing) => !existing.is_empty() && !existing.ends_with('\n'),
            None => false,
        };
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(path).map_err(io_err)?;

        let mut line = String::new();
        if needs_newline {
            line.push('\n');
        }
        line.push_str(&format!(
            "{} {}\n",
            lookup_name(host, port),
            key.to_openssh()
        ));
        file.write_all(line.as_bytes()).map_err(io_err)
    }
}

/// The name OpenSSH looks up: `host` on port 22, else `[host]:port`.
fn lookup_name(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    }
}

fn read_optional(path: &Path) -> Result<Option<String>, KnownHostsError> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(KnownHostsError::Io {
                path: path.to_owned(),
                source,
            })
        }
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|source| KnownHostsError::Io {
            path: path.to_owned(),
            source,
        })?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)
}

#[derive(Debug, PartialEq, Eq)]
enum Marker {
    None,
    CertAuthority,
    Revoked,
}

struct Entry<'a> {
    marker: Marker,
    patterns: &'a str,
    key: HostKey,
}

impl<'a> Entry<'a> {
    /// `None` for blank lines, comments, unknown markers and malformed lines.
    fn parse(line: &'a str) -> Option<Self> {
        let mut fields = line.split_whitespace();
        let mut first = fields.next()?;
        if first.starts_with('#') {
            return None;
        }
        let marker = match first {
            "@cert-authority" => Marker::CertAuthority,
            "@revoked" => Marker::Revoked,
            m if m.starts_with('@') => return None,
            _ => Marker::None,
        };
        if marker != Marker::None {
            first = fields.next()?;
        }
        let algorithm = fields.next()?;
        let blob = fields.next()?;
        let key = HostKey::from_openssh(&format!("{algorithm} {blob}")).ok()?;
        Some(Self {
            marker,
            patterns: first,
            key,
        })
    }

    fn matches_host(&self, name: &str) -> bool {
        let mut matched = false;
        for pattern in self.patterns.split(',') {
            if let Some(hashed) = pattern.strip_prefix("|1|") {
                matched |= hashed_matches(hashed, name);
            } else if let Some(negated) = pattern.strip_prefix('!') {
                if glob_matches(negated, name) {
                    return false;
                }
            } else {
                matched |= glob_matches(pattern, name);
            }
        }
        matched
    }
}

/// `salt|hash` (both base64): HMAC-SHA1 keyed with the salt over the name.
fn hashed_matches(salt_and_hash: &str, name: &str) -> bool {
    let Some((salt, hash)) = salt_and_hash.split_once('|') else {
        return false;
    };
    let (Ok(salt), Ok(hash)) = (BASE64.decode(salt), BASE64.decode(hash)) else {
        return false;
    };
    let Ok(mut mac) = <Hmac<Sha1> as KeyInit>::new_from_slice(&salt) else {
        return false;
    };
    mac.update(name.as_bytes());
    mac.verify_slice(&hash).is_ok()
}

/// Case-insensitive glob with `*` (any run) and `?` (any one character).
fn glob_matches(pattern: &str, name: &str) -> bool {
    let pattern: Vec<char> = pattern.to_lowercase().chars().collect();
    let name: Vec<char> = name.to_lowercase().chars().collect();
    let (mut p, mut n) = (0, 0);
    let mut backtrack: Option<(usize, usize)> = None;
    while n < name.len() {
        match pattern.get(p) {
            Some('*') => {
                backtrack = Some((p, n));
                p += 1;
            }
            Some(&c) if c == '?' || c == name[n] => {
                p += 1;
                n += 1;
            }
            _ => match backtrack {
                Some((star, matched)) => {
                    p = star + 1;
                    n = matched + 1;
                    backtrack = Some((star, matched + 1));
                }
                None => return false,
            },
        }
    }
    pattern[p..].iter().all(|&c| c == '*')
}
