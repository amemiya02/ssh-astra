//! Parsed Host settings and the problems reported by import sources.

use std::borrow::Cow;
use std::net::Ipv6Addr;
use std::path::{Component, Path, PathBuf};

use encoding_rs::{Encoding, WINDOWS_1252};
use serde::{Deserialize, Serialize};

use crate::forward::ForwardDraft;

mod csv;
pub use csv::parse_csv;

mod mobaxterm;
pub use mobaxterm::parse_mobaxterm;

mod putty;
pub use putty::parse_putty;

mod securecrt;
pub use securecrt::{parse_securecrt, SECURECRT_NON_SESSION_FILES};

mod xshell;
pub use xshell::parse_xshell;

/// A Host as the source describes it, ready to save. `jump_host` names
/// another `ConfigHost` (or an already saved Host) by name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigHost {
    pub name: String,
    pub address: String,
    pub port: u16,
    pub user: String,
    /// `~/` is kept as written; `HostAuth::Key` understands it.
    pub identity_file: Option<PathBuf>,
    pub identities_only: bool,
    pub forward_agent: bool,
    pub keepalive_seconds: Option<u32>,
    pub jump_host: Option<String>,
    pub proxy_command: Option<String>,
    pub forwards: Vec<ForwardDraft>,
    /// Group names from the top level to the Host's immediate Group.
    pub group_path: Vec<String>,
}

/// Something in the config that could not be imported as written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportIssue {
    /// A Host alias, directive, or relative source location.
    pub entry: String,
    /// One-based physical line for issues reported by location.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    /// The Host was not imported at all (otherwise only this part of it).
    pub dropped: bool,
    pub problem: ImportProblem,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ImportProblem {
    /// A directive's value could not be understood.
    InvalidValue {
        directive: String,
        value: String,
    },
    /// A directive sshastra cannot do (yet).
    Unsupported {
        directive: String,
    },
    /// An `Include` could not be read.
    IncludeFailed {
        reason: String,
    },
    /// A `ProxyJump` chain goes through Host `hop`, which the config itself
    /// reaches another way; a Host has one Jump host chain.
    JumpChainConflict {
        hop: String,
    },
    /// The Jump hosts lead back to this Host.
    JumpHostLoop,
    /// The Jump host `hop` is not imported, so neither is this Host.
    JumpHostUnavailable {
        hop: String,
    },
    CsvHeaders,
    CsvMissingField {
        field: &'static str,
    },
    CsvInvalidPort,
    CsvInvalidGroup,
    CsvMalformedRecord,
    PuttyFile,
    PuttySessionName,
    PuttyCredentials,
    PuttyUnsupportedProtocol,
    PuttyDefaultUser,
    PuttyInvalidOption {
        option: &'static str,
    },
    PuttyUnsupportedOptions {
        options: String,
    },
    MobaxtermFile,
    MobaxtermSession,
    MobaxtermUnsupportedSession,
    MobaxtermInvalidPort,
    MobaxtermInvalidGroup,
    MobaxtermInvalidGateway,
    MobaxtermDefaultUser,
    MobaxtermKeyPath,
    MobaxtermUnsupportedSettings,
    XshellCredentials,
    XshellFile,
    XshellFolderLimit,
    XshellInvalidPort,
    XshellUnsupportedSession,
    XshellDefaultUser,
    XshellKeyPath,
    XshellUnsupportedSettings,
    XshellUnsupportedProxy,
    XshellInvalidJumpHost,
    SecurecrtCredentials,
    SecurecrtFile,
    SecurecrtFolderLimit,
    SecurecrtInvalidPort,
    SecurecrtUnsupportedSession,
    SecurecrtDefaultUser,
    SecurecrtKeyPath,
    SecurecrtUnsupportedSettings,
    SecurecrtUnsupportedFirewall,
    SecurecrtJumpHostUnavailable,
}

/// The outcome of parsing an import source.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedConfig {
    pub hosts: Vec<ConfigHost>,
    pub issues: Vec<ImportIssue>,
}

fn decode_windows_text(bytes: &[u8]) -> Option<Cow<'_, str>> {
    if let Some((encoding, bom_length)) = Encoding::for_bom(bytes) {
        let (text, malformed) = encoding.decode_without_bom_handling(&bytes[bom_length..]);
        return (!malformed).then_some(text);
    }
    Some(match std::str::from_utf8(bytes) {
        Ok(text) => text.into(),
        Err(_) => WINDOWS_1252.decode_without_bom_handling(bytes).0,
    })
}

fn valid_label(value: &str) -> bool {
    !value.is_empty() && !value.chars().any(char::is_control)
}

fn ssh_address(value: &str) -> Option<&str> {
    let host = value
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(value);
    if host.contains(':') {
        return host.parse::<Ipv6Addr>().is_ok().then_some(host);
    }
    let valid = value == host
        && !host.is_empty()
        && host
            .chars()
            .all(|ch| ch.is_alphanumeric() || matches!(ch, '.' | '-' | '_'));
    valid.then_some(host)
}

fn relative_session_path<'a>(path: &'a Path, extension: &str) -> Option<Vec<&'a str>> {
    if !path.extension()?.to_str()?.eq_ignore_ascii_case(extension) {
        return None;
    }
    path.components()
        .map(|component| {
            let Component::Normal(part) = component else {
                return None;
            };
            let part = part.to_str()?;
            (valid_label(part) && !part.trim().is_empty() && !part.contains(['\\', ':']))
                .then_some(part)
        })
        .collect()
}

fn portable_key_path(value: &str) -> Option<PathBuf> {
    let value = value
        .strip_prefix('"')
        .and_then(|path| path.strip_suffix('"'))
        .unwrap_or(value);
    let windows_absolute =
        matches!(value.as_bytes(), [drive, b':', b'\\' | b'/', ..] if drive.is_ascii_alphabetic());
    if !valid_label(value) || value.contains("://") {
        return None;
    }
    (Path::new(value).is_absolute()
        || windows_absolute
        || value.starts_with("~/")
        || value.starts_with("\\\\"))
    .then(|| PathBuf::from(value))
}
