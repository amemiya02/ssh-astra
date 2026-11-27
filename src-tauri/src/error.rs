use serde::Serialize;
use serde_json::{json, Value};
use sshastra_core::credentials::VaultError;
use sshastra_core::edit::EditError;
use sshastra_core::files::FsError;
use sshastra_core::forward::ForwardError;
use sshastra_core::hosts::HostStoreError;
use sshastra_core::known_hosts::KnownHostsError;
use sshastra_core::settings::SettingsError;
use sshastra_core::snippets::SnippetStoreError;
use sshastra_core::ssh::{ConnectError, HostKeyRecord};
use sshastra_core::ssh_config_export::ExportError;
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

    pub fn window_closed() -> Self {
        Self::new("windowClosed", "the Window closed")
    }

    pub fn temporary_host_unavailable() -> Self {
        Self::new(
            "temporaryHostUnavailable",
            "this Temporary Host is no longer available",
        )
    }

    pub fn open_ssh_home_unavailable() -> Self {
        Self::new(
            "homeUnavailable",
            "the OpenSSH home directory is unavailable",
        )
    }

    pub fn open_ssh_approval_expired() -> Self {
        Self::new("configChanged", "the OpenSSH Include approval has expired")
    }

    pub fn open_ssh_read_changed() -> Self {
        Self::new("readReviewChanged", "the OpenSSH import review has changed")
    }

    fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

impl From<ExportError> for CommandError {
    fn from(err: ExportError) -> Self {
        Self::new(err.kind(), err)
    }
}

impl From<TerminalError> for CommandError {
    fn from(err: TerminalError) -> Self {
        use TerminalError::*;
        let kind = match err {
            Spawn(_) => "spawn",
            Io(_) => "io",
            Log(_) | Recording(_) => "io",
            NotFound(_) => "notFound",
        };
        Self::new(kind, err)
    }
}

impl From<std::io::Error> for CommandError {
    fn from(err: std::io::Error) -> Self {
        Self::new("io", err)
    }
}

impl From<KnownHostsError> for CommandError {
    fn from(err: KnownHostsError) -> Self {
        Self::new("knownHosts", err)
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
            NotFound(_) | GroupNotFound(_) | ForwardNotFound(_) | BookmarkNotFound => {
                Self::new("notFound", &err)
            }
            InvalidBookmarkPath => Self::new("invalid", &err),
            TagLimit { host } => {
                Self::new("hostTagLimit", &err).with_details(json!({ "host": host }))
            }
            DuplicateId(_) => Self::new("duplicateHostId", &err),
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

impl From<SnippetStoreError> for CommandError {
    fn from(err: SnippetStoreError) -> Self {
        use SnippetStoreError::*;
        match &err {
            Io { .. } => Self::new("io", &err),
            Corrupt(_) => Self::new("snippetStoreCorrupt", &err),
            UnsupportedVersion(_) => Self::new("snippetStoreUnsupportedVersion", &err),
            Invalid(field) => Self::new("invalid", &err).with_details(json!({ "field": field })),
            NotFound(_) => Self::new("notFound", &err),
        }
    }
}

impl From<ForwardError> for CommandError {
    fn from(err: ForwardError) -> Self {
        use ForwardError::*;
        let kind = match &err {
            PortInUse(_) => "portInUse",
            PermissionDenied(_) => "permissionDenied",
            Listen { .. } => "listenFailed",
            RemoteRefused(_) => "remoteRefused",
            ConnectionLost => "connectionLost",
        };
        match err.endpoint() {
            Some(at) => {
                let details = json!(at);
                Self::new(kind, &err).with_details(details)
            }
            None => Self::new(kind, &err),
        }
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
            OwnershipUnavailable(p) => {
                Self::new("ownershipUnavailable", &err).with_details(path(p))
            }
            NotADirectory(p) => Self::new("notADirectory", &err).with_details(path(p)),
            AlreadyExists(p) => Self::new("alreadyExists", &err).with_details(path(p)),
            InvalidName => Self::new("invalidName", &err),
            ArchiveUnavailable => Self::new("archiveUnavailable", &err),
            ArchiveUnsupported(p) => Self::new("archiveUnsupported", &err).with_details(path(p)),
            ArchiveNotAFile => Self::new("archiveNotAFile", &err),
            ArchiveToolMissing(tool) => {
                Self::new("archiveToolMissing", &err).with_details(json!({ "tool": tool }))
            }
            ArchiveFailed(_) => Self::new("archiveFailed", &err),
            ArchiveIncomplete { path: p, .. } => {
                Self::new("archiveIncomplete", &err).with_details(path(p))
            }
            TooLarge { path, limit } => {
                let details = json!({ "path": path, "limit": limit });
                Self::new("tooLarge", &err).with_details(details)
            }
            TimedOut => Self::new("timedOut", &err),
            Protocol(_) | AtomicReplacementUnavailable => Self::new("protocol", &err),
            Io(_) => Self::new("io", &err),
        }
    }
}

impl From<EditError> for CommandError {
    fn from(err: EditError) -> Self {
        match err {
            EditError::Fs(fs) => fs.into(),
            EditError::Io(_) => Self::new("io", err),
            EditError::Open(_) => Self::new("openFailed", err),
            EditError::NotOpen => Self::new("notOpen", err),
            EditError::ConflictExpired => Self::new("editConflictExpired", err),
            EditError::NotAFile => Self::new("notAFile", err),
            EditError::Binary => Self::new("binary", err),
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
            Proxy(error) => Self::new(error.kind(), error),
            ProxyCommandInvalid => Self::new("proxyCommandInvalid", &err),
            ProxyCommandTarget => Self::new("proxyCommandTarget", &err),
            ProxyCommandStart(_) => Self::new("proxyCommandStart", &err),
            ProxyCommandFailed { .. } => Self::new("proxyCommandFailed", &err),
            TimedOut => Self::new("timedOut", &err),
            HostKeyMismatch {
                host,
                port,
                fingerprint,
                known,
            } => {
                let mut details = json!({
                    "host": host,
                    "port": port,
                    "fingerprint": fingerprint,
                });
                match known {
                    HostKeyRecord::KnownHosts(known) => {
                        details["knownFingerprint"] = json!(known.fingerprint);
                        details["knownHostsPath"] = json!(known.path.display().to_string());
                        details["line"] = json!(known.line);
                    }
                    HostKeyRecord::ThisRun { fingerprint } => {
                        details["knownFingerprint"] = json!(fingerprint);
                    }
                }
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
            SshLinkTargetChanged => Self::new("sshLinkTargetChanged", &err),
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
    use sshastra_core::forward::Endpoint;

    #[test]
    fn a_taken_port_names_the_address_and_port() {
        let err = ForwardError::PortInUse(Endpoint::new("127.0.0.1", 5432));

        let json = serde_json::to_value(CommandError::from(err)).unwrap();

        assert_eq!(json["kind"], "portInUse");
        assert_eq!(json["details"]["address"], "127.0.0.1");
        assert_eq!(json["details"]["port"], 5432);
        assert_eq!(json["message"], "port 5432 on 127.0.0.1 is already in use");
    }

    #[test]
    fn a_refused_remote_port_names_the_address_and_port() {
        let err = ForwardError::RemoteRefused(Endpoint::new("localhost", 9000));

        let json = serde_json::to_value(CommandError::from(err)).unwrap();

        assert_eq!(json["kind"], "remoteRefused");
        assert_eq!(json["details"]["address"], "localhost");
        assert_eq!(json["details"]["port"], 9000);
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

    #[test]
    fn host_key_mismatch_for_this_run_has_no_file_location() {
        let err = ConnectError::HostKeyMismatch {
            host: "host.example".into(),
            port: 22,
            fingerprint: "SHA256:presented".into(),
            known: HostKeyRecord::ThisRun {
                fingerprint: "SHA256:expected".into(),
            },
        };

        let json = serde_json::to_value(CommandError::from(err)).unwrap();

        assert_eq!(json["kind"], "hostKeyMismatch");
        assert_eq!(
            json["details"],
            json!({
                "host": "host.example",
                "port": 22,
                "fingerprint": "SHA256:presented",
                "knownFingerprint": "SHA256:expected",
            })
        );
    }
}
