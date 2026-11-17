//! The CredentialVault: Host passwords and key passphrases the user chose to
//! save, kept in the operating system's secret store (macOS Keychain, Windows
//! Credential Manager, Secret Service on Linux) under "Host id + kind". No
//! credential is ever written to sshastra's own files.
//!
//! [`system_vault`] picks the platform store, or [`NoVault`] where there is
//! none (e.g. Linux without a Secret Service): then nothing is saved and the
//! user is asked every time. Tests use [`MemoryVault`].

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::hosts::HostId;

/// The service name every sshastra entry is filed under in the system store.
pub const SERVICE: &str = "sshastra";

/// Which secret of a Host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CredentialKind {
    /// The login password.
    Password,
    /// The passphrase of the Host's private key file.
    KeyPassphrase,
}

impl CredentialKind {
    pub const ALL: [CredentialKind; 2] = [CredentialKind::Password, CredentialKind::KeyPassphrase];

    /// The account name of `host`'s entry of this kind in the system store,
    /// e.g. `<host id>:password`.
    pub fn account(self, host: &HostId) -> String {
        let kind = match self {
            CredentialKind::Password => "password",
            CredentialKind::KeyPassphrase => "key-passphrase",
        };
        format!("{host}:{kind}")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("credential store: {0}")]
pub struct VaultError(pub String);

/// Where saved credentials live. Calls may block (a keychain can show a
/// dialog): call them from blocking threads.
pub trait CredentialVault: Send + Sync {
    /// Whether saving works at all; when false the UI does not offer it.
    fn can_save(&self) -> bool {
        true
    }
    /// The saved secret, `None` if there is none.
    fn get(&self, host: &HostId, kind: CredentialKind) -> Result<Option<String>, VaultError>;
    fn set(&self, host: &HostId, kind: CredentialKind, secret: &str) -> Result<(), VaultError>;
    /// Forgets the secret; not having one is fine.
    fn delete(&self, host: &HostId, kind: CredentialKind) -> Result<(), VaultError>;
    /// Forgets every secret of `host`.
    fn clear(&self, host: &HostId) -> Result<(), VaultError> {
        CredentialKind::ALL
            .into_iter()
            .try_for_each(|kind| self.delete(host, kind))
    }
}

/// Saves nothing: every connect asks.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoVault;

impl CredentialVault for NoVault {
    fn can_save(&self) -> bool {
        false
    }
    fn get(&self, _: &HostId, _: CredentialKind) -> Result<Option<String>, VaultError> {
        Ok(None)
    }
    fn set(&self, _: &HostId, _: CredentialKind, _: &str) -> Result<(), VaultError> {
        Ok(())
    }
    fn delete(&self, _: &HostId, _: CredentialKind) -> Result<(), VaultError> {
        Ok(())
    }
}

/// Keeps secrets in memory, for tests.
#[derive(Debug, Default)]
pub struct MemoryVault {
    entries: Mutex<HashMap<(HostId, CredentialKind), String>>,
}

impl MemoryVault {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(HostId, CredentialKind), String>> {
        self.entries.lock().unwrap_or_else(|p| p.into_inner())
    }
}

impl CredentialVault for MemoryVault {
    fn get(&self, host: &HostId, kind: CredentialKind) -> Result<Option<String>, VaultError> {
        Ok(self.lock().get(&(host.clone(), kind)).cloned())
    }
    fn set(&self, host: &HostId, kind: CredentialKind, secret: &str) -> Result<(), VaultError> {
        self.lock().insert((host.clone(), kind), secret.to_owned());
        Ok(())
    }
    fn delete(&self, host: &HostId, kind: CredentialKind) -> Result<(), VaultError> {
        self.lock().remove(&(host.clone(), kind));
        Ok(())
    }
}

/// The operating system's secret store through `keyring`.
struct SystemVault;

impl SystemVault {
    fn entry(host: &HostId, kind: CredentialKind) -> Result<keyring::Entry, VaultError> {
        keyring::Entry::new(SERVICE, &kind.account(host)).map_err(vault_error)
    }
}

fn vault_error(e: keyring::Error) -> VaultError {
    VaultError(e.to_string())
}

impl CredentialVault for SystemVault {
    fn get(&self, host: &HostId, kind: CredentialKind) -> Result<Option<String>, VaultError> {
        match Self::entry(host, kind)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(vault_error(e)),
        }
    }
    fn set(&self, host: &HostId, kind: CredentialKind, secret: &str) -> Result<(), VaultError> {
        Self::entry(host, kind)?
            .set_password(secret)
            .map_err(vault_error)
    }
    fn delete(&self, host: &HostId, kind: CredentialKind) -> Result<(), VaultError> {
        match Self::entry(host, kind)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(vault_error(e)),
        }
    }
}

/// The platform's secret store, or [`NoVault`] when it is unavailable (e.g.
/// no Secret Service on Linux: there the store may load yet fail on first
/// use, so it is probed with a lookup). May block briefly.
pub fn system_vault() -> Arc<dyn CredentialVault> {
    if keyring::Entry::store_status().is_err() {
        return Arc::new(NoVault);
    }
    let probe = HostId::from(String::from("availability-probe"));
    match SystemVault.get(&probe, CredentialKind::Password) {
        Ok(_) => Arc::new(SystemVault),
        Err(_) => Arc::new(NoVault),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_entries_are_named_by_host_id_and_kind() {
        let host = HostId::from(String::from("3f2a"));
        assert_eq!(CredentialKind::Password.account(&host), "3f2a:password");
        assert_eq!(
            CredentialKind::KeyPassphrase.account(&host),
            "3f2a:key-passphrase"
        );
    }

    #[test]
    fn clearing_forgets_every_kind_of_one_host_only() {
        let vault = MemoryVault::default();
        let (a, b) = (HostId::from("a".to_owned()), HostId::from("b".to_owned()));
        for kind in CredentialKind::ALL {
            vault.set(&a, kind, "s").unwrap();
            vault.set(&b, kind, "s").unwrap();
        }

        vault.clear(&a).unwrap();

        for kind in CredentialKind::ALL {
            assert_eq!(vault.get(&a, kind), Ok(None));
            assert_eq!(vault.get(&b, kind), Ok(Some("s".to_owned())));
        }
    }
}
