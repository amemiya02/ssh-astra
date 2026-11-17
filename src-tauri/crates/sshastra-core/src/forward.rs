//! Port forwards: the rules saved on a Host ([`PortForward`]) and the
//! [`PortForwarder`] that runs them over the Host's Connection.
//!
//! Only local forwards (`ssh -L`) exist so far; remote (`-R`) and dynamic
//! SOCKS (`-D`) forwards become further [`ForwardKind`] variants.

mod forwarder;

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

/// What a Port forward tunnels. Stored flat next to the rule's `id` and
/// `label`, tagged by `type`.
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
}

/// A saved Port forward rule on a Host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForward {
    pub id: ForwardId,
    /// The user's name for the rule; may be empty.
    #[serde(default)]
    pub label: String,
    #[serde(flatten)]
    pub kind: ForwardKind,
}

/// A rule's editable fields, as entered in the Port forward form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardDraft {
    #[serde(default)]
    pub label: String,
    #[serde(flatten)]
    pub kind: ForwardKind,
}

/// Where a local forward listens when the bind address is left blank.
pub const LOOPBACK: &str = "127.0.0.1";

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
        };
        Ok(PortForward {
            id,
            label: self.label.trim().to_owned(),
            kind,
        })
    }
}
