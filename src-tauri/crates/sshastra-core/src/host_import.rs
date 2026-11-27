//! Parsed Host settings and the problems reported by import sources.

use std::path::PathBuf;

use serde::Serialize;

use crate::forward::ForwardDraft;

mod csv;
pub use csv::parse_csv;

mod putty;
pub use putty::parse_putty;

/// A Host as the source describes it, ready to save. `jump_host` names
/// another `ConfigHost` (or an already saved Host) by name.
#[derive(Debug, Clone, PartialEq, Eq)]
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
    /// The Host alias, OpenSSH directive, or PuTTY session name.
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
}

/// The outcome of parsing an import source.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedConfig {
    pub hosts: Vec<ConfigHost>,
    pub issues: Vec<ImportIssue>,
}
