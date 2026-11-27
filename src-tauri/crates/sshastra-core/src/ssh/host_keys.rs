//! Verify server keys against OpenSSH's files and trust granted for this run.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use russh::keys::PublicKeyOrCertificate;

use super::{ConnectError, HostKeyDecision, HostKeyPrompt, Prompter};
use crate::hosts::HostId;
use crate::known_hosts::{HostKey, KnownHost, KnownHosts, Verdict};

/// Where the expected key for a blocked Connection was recorded.
#[derive(Debug)]
pub enum HostKeyRecord {
    KnownHosts(KnownHost),
    ThisRun { fingerprint: String },
}

impl fmt::Display for HostKeyRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::KnownHosts(known) => write!(
                f,
                "{} in {} line {}",
                known.fingerprint,
                known.path.display(),
                known.line
            ),
            Self::ThisRun { fingerprint } => write!(f, "{fingerprint} in memory for this run"),
        }
    }
}

/// Addresses reached through different Jump hosts can name different machines.
#[derive(PartialEq, Eq, Hash)]
pub(super) struct Endpoint {
    pub(super) id: HostId,
    pub(super) address: String,
    pub(super) port: u16,
    pub(super) via: Option<Arc<Endpoint>>,
}

pub(super) struct HostKeys {
    /// Scopes share the lock so rechecking and saving a key stays atomic.
    known_hosts: Arc<Mutex<KnownHosts>>,
    temporary: Mutex<HashMap<Arc<Endpoint>, HostKey>>,
}

#[derive(PartialEq, Eq)]
enum Trust {
    Saved,
    ThisRun,
    Unknown,
}

impl HostKeys {
    pub(super) fn new(known_hosts: KnownHosts) -> Self {
        Self {
            known_hosts: Arc::new(Mutex::new(known_hosts)),
            temporary: Mutex::default(),
        }
    }

    pub(super) fn scoped(&self) -> Self {
        Self {
            known_hosts: Arc::clone(&self.known_hosts),
            temporary: Mutex::default(),
        }
    }

    pub(super) async fn verify(
        &self,
        endpoint: &Arc<Endpoint>,
        key: &PublicKeyOrCertificate,
        prompter: &dyn Prompter,
    ) -> Result<(), ConnectError> {
        let key = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => HostKey::from(key.clone()),
            PublicKeyOrCertificate::Certificate(_) => {
                return Err(ConnectError::HostCertificateUnsupported)
            }
        };
        {
            let known_hosts = self.known_hosts.lock().unwrap_or_else(|p| p.into_inner());
            let temporary = self.temporary.lock().unwrap_or_else(|p| p.into_inner());
            if Self::trust(&known_hosts, endpoint, &key, temporary.get(endpoint))? != Trust::Unknown
            {
                return Ok(());
            }
        }

        let prompt = HostKeyPrompt {
            host: endpoint.address.clone(),
            port: endpoint.port,
            algorithm: key.algorithm(),
            fingerprint: key.fingerprint(),
        };
        let save = match prompter.confirm_host_key(prompt).await {
            HostKeyDecision::Reject => return Err(ConnectError::HostKeyDeclined),
            HostKeyDecision::TrustForRun => false,
            HostKeyDecision::SaveAndTrust => true,
        };

        // Another handshake or a file edit may have recorded or revoked the key
        // while this prompt was open. Recheck under the same lock as the update.
        let known_hosts = self.known_hosts.lock().unwrap_or_else(|p| p.into_inner());
        let mut temporary = self.temporary.lock().unwrap_or_else(|p| p.into_inner());
        match (
            Self::trust(&known_hosts, endpoint, &key, temporary.get(endpoint))?,
            save,
        ) {
            (Trust::Saved, _) | (Trust::ThisRun, false) => {}
            (_, true) => known_hosts.accept(&endpoint.address, endpoint.port, &key)?,
            (Trust::Unknown, false) => {
                temporary.insert(Arc::clone(endpoint), key);
            }
        }
        Ok(())
    }

    fn trust(
        known_hosts: &KnownHosts,
        endpoint: &Endpoint,
        key: &HostKey,
        temporary: Option<&HostKey>,
    ) -> Result<Trust, ConnectError> {
        let mismatch = |known| ConnectError::HostKeyMismatch {
            host: endpoint.address.clone(),
            port: endpoint.port,
            fingerprint: key.fingerprint(),
            known,
        };
        let saved = match known_hosts.verify(&endpoint.address, endpoint.port, key)? {
            Verdict::Match => true,
            Verdict::Unknown => false,
            Verdict::Mismatch(known) => return Err(mismatch(HostKeyRecord::KnownHosts(known))),
            Verdict::Revoked => {
                return Err(ConnectError::HostKeyRevoked {
                    fingerprint: key.fingerprint(),
                })
            }
        };
        if let Some(expected) = temporary.filter(|expected| !expected.same_key(key)) {
            return Err(mismatch(HostKeyRecord::ThisRun {
                fingerprint: expected.fingerprint(),
            }));
        }
        Ok(if saved {
            Trust::Saved
        } else if temporary.is_some() {
            Trust::ThisRun
        } else {
            Trust::Unknown
        })
    }
}
