use serde::Serialize;
use serde_json::{json, Value};
use sshastra_core::hosts::HostStoreError;
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
            NotFound(_) | GroupNotFound(_) => Self::new("notFound", &err),
            InvalidMove => Self::new("invalidMove", &err),
        }
    }
}

impl From<ConnectError> for CommandError {
    fn from(err: ConnectError) -> Self {
        use ConnectError::*;
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
            Cancelled => Self::new("cancelled", &err),
            Protocol(_) => Self::new("protocol", &err),
        }
    }
}

pub type CommandResult<T> = Result<T, CommandError>;
