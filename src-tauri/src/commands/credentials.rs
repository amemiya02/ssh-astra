//! Credential commands: the passwords and key passphrases saved in the
//! CredentialVault (the system keychain).

use std::sync::Arc;

use sshastra_core::credentials::{CredentialKind, CredentialVault, VaultError};
use sshastra_core::hosts::HostId;
use tauri::State;

use crate::error::CommandResult;

/// The app's CredentialVault: the system keychain, or one that saves nothing
/// where there is none.
#[derive(Clone)]
pub struct Vault(pub Arc<dyn CredentialVault>);

impl Vault {
    /// Forgets every saved secret of `id` off the UI thread (a keychain may
    /// block).
    pub async fn clear(&self, id: HostId) -> CommandResult<()> {
        let vault = Arc::clone(&self.0);
        tauri::async_runtime::spawn_blocking(move || vault.clear(&id))
            .await
            .map_err(|e| VaultError(e.to_string()))??;
        Ok(())
    }
}

/// Forgets the saved credentials of a Host. Its next connect asks again.
#[tauri::command]
pub async fn host_credentials_clear(vault: State<'_, Vault>, id: HostId) -> CommandResult<()> {
    vault.clear(id).await
}

/// Forgets the password for the app-wide outbound proxy.
#[tauri::command]
pub async fn global_proxy_password_clear(vault: State<'_, Vault>) -> CommandResult<()> {
    let vault = Arc::clone(&vault.0);
    tauri::async_runtime::spawn_blocking(move || {
        vault.delete(
            &CredentialKind::global_proxy_owner(),
            CredentialKind::GlobalProxyPassword,
        )
    })
    .await
    .map_err(|_| VaultError("could not clear the outbound proxy password".to_owned()))?
    .map_err(|_| VaultError("could not clear the outbound proxy password".to_owned()))?;
    Ok(())
}
