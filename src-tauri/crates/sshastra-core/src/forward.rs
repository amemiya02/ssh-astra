//! Port forwards: the rules saved on a Host ([`PortForward`]) and the
//! [`PortForwarder`] that runs them over the Host's Connection.
//!
//! Three kinds ([`ForwardKind`]): local (`ssh -L`), remote (`ssh -R`) and
//! dynamic, a SOCKS5 proxy (`ssh -D`).

mod forwarder;
mod socks;

pub use forwarder::{ForwardError, ForwardEvent, ForwardStatus, PortForwarder};

use std::fmt;

use serde::{Deserialize, Serialize};

/// Identifies a Port forward rule; unique across all Hosts.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ForwardId(String);

impl ForwardId {
    pub(crate) fn generate() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }
}

impl From<String> for ForwardId {
    fn from(raw: String) -> Self {
        Self(raw)
    }
}

impl fmt::Display for ForwardId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// What a Port forward tunnels. Stored flat next to the rule's `id`,
/// `label` and `autoStart`, tagged by `type`. This JSON shape is shared by
/// the hosts file, IPC and Host list import/export, so keep it stable:
///
/// ```json
/// { "id": "…", "label": "", "autoStart": false, "type": "local",
///   "bindAddress": "127.0.0.1", "bindPort": 15432, "remoteHost": "db", "remotePort": 5432 }
/// { "id": "…", "label": "", "autoStart": false, "type": "remote",
///   "bindAddress": "localhost", "bindPort": 9000, "localHost": "127.0.0.1", "localPort": 3000 }
/// { "id": "…", "label": "", "autoStart": true, "type": "dynamic",
///   "bindAddress": "127.0.0.1", "bindPort": 1080 }
/// ```
///
/// `ssh -L [bind:]port:host:hostport`, `-R [bind:]port:host:hostport` and
/// `-D [bind:]port` map one-to-one onto `local`, `remote` and `dynamic`
/// (`bindAddress` blank for the defaults, which [`ForwardDraft`] fills in).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ForwardKind {
    /// Listens on `bind_address:bind_port` on this machine; every connection
    /// to it is carried to `remote_host:remote_port`, as the server sees that
    /// address (`ssh -L`).
    Local {
        bind_address: String,
        bind_port: u16,
        remote_host: String,
        remote_port: u16,
    },
    /// Has the server listen on `bind_address:bind_port` (its side); every
    /// connection it accepts there is carried to `local_host:local_port` as
    /// this machine sees that address (`ssh -R`).
    Remote {
        bind_address: String,
        bind_port: u16,
        local_host: String,
        local_port: u16,
    },
    /// A SOCKS5 proxy on `bind_address:bind_port` on this machine: each
    /// client's destination is opened by the server (`ssh -D`).
    Dynamic {
        bind_address: String,
        bind_port: u16,
    },
}

/// A saved Port forward rule on a Host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForward {
    pub id: ForwardId,
    /// The user's name for the rule; may be empty.
    #[serde(default)]
    pub label: String,
    /// Start the rule whenever its Host connects (see
    /// [`PortForwarder::start_auto`]).
    pub auto_start: bool,
    #[serde(flatten)]
    pub kind: ForwardKind,
}

/// A rule's editable fields, as entered in the Port forward form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardDraft {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(flatten)]
    pub kind: ForwardKind,
}

/// Where a local forward listens when the bind address is left blank.
pub const LOOPBACK: &str = "127.0.0.1";

/// Where the server listens for a remote forward when the bind address is
/// left blank: its loopback interfaces only, as `ssh -R` asks.
pub const REMOTE_LOOPBACK: &str = "localhost";

impl ForwardDraft {
    /// The rule, trimmed and checked; `Err` names the first invalid field.
    pub(crate) fn into_forward(self, id: ForwardId) -> Result<PortForward, &'static str> {
        let kind = match self.kind {
            ForwardKind::Local {
                bind_address,
                bind_port,
                remote_host,
                remote_port,
            } => {
                let bind_address = match bind_address.trim() {
                    "" => LOOPBACK.to_owned(),
                    other => other.to_owned(),
                };
                let remote_host = remote_host.trim().to_owned();
                if bind_port == 0 {
                    return Err("bindPort");
                }
                if remote_host.is_empty() {
                    return Err("remoteHost");
                }
                if remote_port == 0 {
                    return Err("remotePort");
                }
                ForwardKind::Local {
                    bind_address,
                    bind_port,
                    remote_host,
                    remote_port,
                }
            }
            ForwardKind::Remote {
                bind_address,
                bind_port,
                local_host,
                local_port,
            } => {
                let bind_address = match bind_address.trim() {
                    "" => REMOTE_LOOPBACK.to_owned(),
                    other => other.to_owned(),
                };
                let local_host = local_host.trim().to_owned();
                if bind_port == 0 {
                    return Err("bindPort");
                }
                if local_host.is_empty() {
                    return Err("localHost");
                }
                if local_port == 0 {
                    return Err("localPort");
                }
                ForwardKind::Remote {
                    bind_address,
                    bind_port,
                    local_host,
                    local_port,
                }
            }
            ForwardKind::Dynamic {
                bind_address,
                bind_port,
            } => {
                if bind_port == 0 {
                    return Err("bindPort");
                }
                ForwardKind::Dynamic {
                    bind_address: match bind_address.trim() {
                        "" => LOOPBACK.to_owned(),
                        other => other.to_owned(),
                    },
                    bind_port,
                }
            }
        };
        Ok(PortForward {
            id,
            label: self.label.trim().to_owned(),
            auto_start: self.auto_start,
            kind,
        })
    }
}
