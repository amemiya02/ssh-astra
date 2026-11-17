use serde::Serialize;
use serde_json::{json, Value};
use sshastra_core::credentials::VaultError;
use sshastra_core::files::FsError;
use sshastra_core::forward::ForwardError;
use sshastra_core::hosts::HostStoreError;
use sshastra_core::settings::SettingsError;
use sshastra_core::ssh::ConnectError;
use sshastra_core::terminal::TerminalError;

/// The error every command returns. Serialized to the front end as
/// `{ kind, message, details? }` so the UI can branch on `kind`, show
/// `message`, and render structured `details` where a kind has them.
#[derive(Debug, Clone, Serialize)]
pub struct CommandError {
    kind: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

impl CommandError {
    fn new(kind: &'static str, err: impl ToString) -> Self {
        Self {
            kind,
            message: err.to_string(),
            details: None,
        }
    }

    /// A File panel id that is not (or no longer) open.
    pub fn not_open() -> Self {
        Self::new("notOpen", "the File panel's SFTP session is closed")
    }

    fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

impl From<TerminalError> for CommandError {
    fn from(err: TerminalError) -> Self {
        use TerminalError::*;
        let kind = match err {
            Spawn(_) => "spawn",
            Io(_) => "io",
            NotFound(_) => "notFound",
        };
        Self::new(kind, err)
    }
}

impl From<VaultError> for CommandError {
    fn from(err: VaultError) -> Self {
        Self::new("credentialStore", err)
    }
}

impl From<HostStoreError> for CommandError {
    fn from(err: HostStoreError) -> Self {
        use HostStoreError::*;
        match &err {
            Io { .. } => Self::new("io", &err),
            Corrupt(_) => Self::new("hostStoreCorrupt", &err),
            UnsupportedVersion(_) => Self::new("hostStoreUnsupportedVersion", &err),
            Invalid(field) => {
                let field = *field;
                Self::new("invalid", &err).with_details(json!({ "field": field }))
            }
            NotFound(_) | GroupNotFound(_) | ForwardNotFound(_) => Self::new("notFound", &err),
            InvalidMove => Self::new("invalidMove", &err),
            JumpHostCycle(names) => {
                let details = json!({ "hosts": names });
                Self::new("jumpHostCycle", &err).with_details(details)
            }
            InUseAsJumpHost { by } => {
                Self::new("inUseAsJumpHost", &err).with_details(json!({ "by": by }))
            }
        }
    }
}

impl From<ForwardError> for CommandError {
    fn from(err: ForwardError) -> Self {
        use ForwardError::*;
        let (kind, address, port) = match &err {
            PortInUse { address, port } => ("portInUse", address, port),
            PermissionDenied { address, port } => ("permissionDenied", address, port),
            Listen { address, port, .. } => ("listenFailed", address, port),
        };
        let details = json!({ "address": address, "port": port });
        Self::new(kind, &err).with_details(details)
    }
}

impl From<SettingsError> for CommandError {
    fn from(err: SettingsError) -> Self {
        use SettingsError::*;
        let kind = match &err {
            Io { .. } => "io",
            Corrupt(_) => "settingsCorrupt",
            UnsupportedVersion(_) => "settingsUnsupportedVersion",
            ReservedSection => "invalid",
        };
        Self::new(kind, err)
    }
}

impl From<FsError> for CommandError {
    fn from(err: FsError) -> Self {
        use FsError::*;
        let path = |p: &String| json!({ "path": p });
        match &err {
            NotConnected => Self::new("notConnected", &err),
            NotFound(p) => Self::new("notFound", &err).with_details(path(p)),
            PermissionDenied(p) => Self::new("permissionDenied", &err).with_details(path(p)),
            NotADirectory(p) => Self::new("notADirectory", &err).with_details(path(p)),
            TimedOut => Self::new("timedOut", &err),
            Protocol(_) => Self::new("protocol", &err),
            Io(_) => Self::new("io", &err),
        }
    }
}

impl From<ConnectError> for CommandError {
    fn from(err: ConnectError) -> Self {
        use ConnectError::*;
        // A failing Jump host keeps the kind (and details) of what went wrong
        // there, plus `details.jumpHost` naming the hop.
        let err = match err {
            JumpHost { name, source } => {
                let message = format!("jump host {name}: {source}");
                let mut inner = Self::from(*source);
                let mut details = inner.details.take().unwrap_or_else(|| json!({}));
                details["jumpHost"] = json!(name);
                inner.message = message;
                return inner.with_details(details);
            }
            other => other,
        };
        match &err {
            Unreachable(_) => Self::new("unreachable", &err),
            TimedOut => Self::new("timedOut", &err),
            HostKeyMismatch {
                host,
                port,
                fingerprint,
                known,
            } => {
                let details = json!({
                    "host": host,
                    "port": port,
                    "fingerprint": fingerprint,
                    "knownFingerprint": known.fingerprint,
                    "knownHostsPath": known.path.display().to_string(),
                    "line": known.line,
                });
                Self::new("hostKeyMismatch", &err).with_details(details)
            }
            HostKeyRevoked { fingerprint } => Self::new("hostKeyRevoked", &err)
                .with_details(json!({ "fingerprint": fingerprint })),
            HostKeyDeclined => Self::new("hostKeyDeclined", &err),
            HostCertificateUnsupported => Self::new("unsupported", &err),
            KnownHosts(_) => Self::new("knownHosts", &err),
            AuthenticationFailed => Self::new("authenticationFailed", &err),
            KeyUnreadable { path, reason } => Self::new("keyUnreadable", &err)
                .with_details(json!({ "keyPath": path.display().to_string(), "reason": reason })),
            KeyPassphraseIncorrect { path } => Self::new("keyPassphraseIncorrect", &err)
                .with_details(json!({ "keyPath": path.display().to_string() })),
            KeyRejected { path } => Self::new("keyRejected", &err)
                .with_details(json!({ "keyPath": path.display().to_string() })),
            AgentKeysRejected => Self::new("agentKeysRejected", &err),
            NoSupportedMethod { methods } => Self::new("noSupportedMethod", &err)
                .with_details(json!({ "methods": methods.join(", ") })),
            Cancelled => Self::new("cancelled", &err),
            Protocol(_) => Self::new("protocol", &err),
            JumpHost { .. } => unreachable!("unwrapped above"),
        }
    }
}

pub type CommandResult<T> = Result<T, CommandError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_taken_port_names_the_address_and_port() {
        let err = ForwardError::PortInUse {
            address: "127.0.0.1".into(),
            port: 5432,
        };

        let json = serde_json::to_value(CommandError::from(err)).unwrap();

        assert_eq!(json["kind"], "portInUse");
        assert_eq!(json["details"]["address"], "127.0.0.1");
        assert_eq!(json["details"]["port"], 5432);
        assert_eq!(json["message"], "port 5432 on 127.0.0.1 is already in use");
    }

    #[test]
    fn a_failing_jump_host_keeps_the_kind_and_names_the_hop() {
        let err = ConnectError::JumpHost {
            name: "bastion".into(),
            source: Box::new(ConnectError::HostKeyRevoked {
                fingerprint: "SHA256:x".into(),
            }),
        };

        let json = serde_json::to_value(CommandError::from(err)).unwrap();

        assert_eq!(json["kind"], "hostKeyRevoked");
        assert_eq!(json["details"]["jumpHost"], "bastion");
        assert_eq!(json["details"]["fingerprint"], "SHA256:x");
        assert!(json["message"].as_str().unwrap().contains("bastion"));
    }
}
