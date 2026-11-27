//! User authentication on a fresh SSH transport. Methods are tried in a fixed
//! order, each only while the server still lists it: ssh-agent, private key
//! files, password, keyboard-interactive. A method the server
//! accepts with "partial success" (e.g. key, then OTP) moves on to the next.
//!
//! A password or key passphrase saved in the CredentialVault is tried before
//! asking; one that no longer works is forgotten, and a typed one the user
//! asked to save is saved once it proves right.
//!
//! When nothing succeeds, the error describes the last method that failed
//! (e.g. a rejected key) so the UI can say why.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use russh::client::{self, AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::{
    load_openssh_certificate, signature, ssh_encoding::Encode, ssh_key, Certificate, HashAlg,
    PrivateKey, PrivateKeyWithHashAlg, PublicKey,
};
use russh::{AgentAuthError, MethodKind, MethodSet, Signer};

use super::handshake::Deadline;
use super::progress::ActiveStep;
use super::{
    AuthMethod, ConnectError, KeyboardInteractivePrompt, KeyboardInteractiveQuestion,
    PassphrasePrompt, PasswordPrompt, Prompter,
};
use crate::credentials::{CredentialKind, CredentialVault};
use crate::hosts::{Host, HostAuth, HostId};

/// Password, passphrase and keyboard-interactive rounds before giving up.
const ATTEMPTS: usize = 3;

/// Where to find an ssh-agent holding the user's keys.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Agent {
    /// Do not use an agent.
    #[default]
    None,
    /// The agent the system provides: `$SSH_AUTH_SOCK` on Unix; the Windows
    /// OpenSSH agent, else Pageant, on Windows. Missing agents are skipped.
    System,
    /// The agent listening on this Unix socket.
    #[cfg(unix)]
    Socket(PathBuf),
    /// The agent listening on this Windows named pipe.
    #[cfg(windows)]
    NamedPipe(PathBuf),
}

pub(super) type DynAgent = AgentClient<Box<dyn AgentStream + Send + Unpin + 'static>>;

impl Agent {
    pub(super) fn from_path(path: &str, home_dir: Option<&Path>) -> Self {
        if path.trim().is_empty() {
            return Self::System;
        }
        let path = expand_home(Path::new(path), home_dir);
        #[cfg(unix)]
        {
            Self::Socket(path)
        }
        #[cfg(windows)]
        {
            Self::NamedPipe(path)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = path;
            Self::None
        }
    }

    pub(super) async fn connect(&self) -> Option<DynAgent> {
        match self {
            Agent::None => None,
            #[cfg(unix)]
            Agent::System => AgentClient::connect_env().await.ok().map(|a| a.dynamic()),
            #[cfg(windows)]
            Agent::System => {
                if let Ok(agent) =
                    AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await
                {
                    return Some(agent.dynamic());
                }
                AgentClient::connect_pageant()
                    .await
                    .ok()
                    .map(|a| a.dynamic())
            }
            #[cfg(not(any(unix, windows)))]
            Agent::System => None,
            #[cfg(unix)]
            Agent::Socket(path) => AgentClient::connect_uds(path)
                .await
                .ok()
                .map(|a| a.dynamic()),
            #[cfg(windows)]
            Agent::NamedPipe(path) => {
                // Open only paths in the local named pipe namespace.
                const PREFIX: &str = r"\\.\pipe\";
                let path = path.to_str()?;
                let name = path.get(PREFIX.len()..)?;
                if !path.get(..PREFIX.len())?.eq_ignore_ascii_case(PREFIX)
                    || name.is_empty()
                    || name.contains(['\\', '/', '\0'])
                    || matches!(name, "." | "..")
                {
                    return None;
                }
                AgentClient::connect_named_pipe(path)
                    .await
                    .ok()
                    .map(|a| a.dynamic())
            }
        }
    }
}

/// What one method achieved.
enum Step {
    /// Fully authenticated.
    Done,
    /// Accepted, but the server wants more (`allowed` now lists what).
    Partial,
    /// Not accepted (or not usable); try the next method.
    Failed(ConnectError),
    /// Not attempted.
    Skipped,
}

/// One Host's entries in the CredentialVault. Vault calls run on blocking
/// threads (a keychain may show a dialog). A failing vault reads as empty and
/// saves nothing: it never breaks a connect.
struct Saved {
    vault: Arc<dyn CredentialVault>,
    host: HostId,
    /// Stopped while the vault is asked: a keychain dialog is a prompt too.
    deadline: Arc<Deadline>,
}

impl Saved {
    fn can_save(&self) -> bool {
        self.vault.can_save()
    }

    async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce(&dyn CredentialVault, &HostId) -> T + Send + 'static,
    ) -> Option<T> {
        let vault = Arc::clone(&self.vault);
        let host = self.host.clone();
        let _pause = self.deadline.pause();
        tokio::task::spawn_blocking(move || f(vault.as_ref(), &host))
            .await
            .ok()
    }

    async fn get(&self, kind: CredentialKind) -> Option<String> {
        self.run(move |vault, host| vault.get(host, kind))
            .await
            .and_then(Result::ok)
            .flatten()
    }

    async fn set(&self, kind: CredentialKind, secret: String) {
        self.run(move |vault, host| vault.set(host, kind, &secret))
            .await;
    }

    async fn delete(&self, kind: CredentialKind) {
        self.run(move |vault, host| vault.delete(host, kind)).await;
    }
}

struct AuthAttempt<'a, 'step, H: client::Handler> {
    progress: &'a mut ActiveStep<'step>,
    handle: &'a mut Handle<H>,
    host: &'a Host,
    prompter: &'a dyn Prompter,
    saved: Saved,
    /// Methods the server still accepts.
    allowed: MethodSet,
}

pub(super) struct AuthSources<'a> {
    pub(super) agent: &'a Agent,
    pub(super) home_dir: Option<&'a Path>,
    pub(super) vault: &'a Arc<dyn CredentialVault>,
}

pub(super) async fn authenticate<H: client::Handler>(
    handle: &mut Handle<H>,
    host: &Host,
    sources: AuthSources<'_>,
    prompter: &dyn Prompter,
    deadline: Arc<Deadline>,
    progress: &mut ActiveStep<'_>,
) -> Result<(), ConnectError> {
    let AuthSources {
        agent,
        home_dir,
        vault,
    } = sources;
    progress.method(AuthMethod::None);
    log_auth(&host.id, "none", "attempting");
    let none = handle.authenticate_none(&host.user).await;
    log_auth(&host.id, "none", auth_result(&none));
    let allowed = match none? {
        AuthResult::Success => return Ok(()),
        AuthResult::Failure {
            remaining_methods, ..
        } => remaining_methods,
    };
    let mut attempt = AuthAttempt {
        progress,
        handle,
        host,
        prompter,
        saved: Saved {
            vault: Arc::clone(vault),
            host: host.id.clone(),
            deadline,
        },
        allowed,
    };

    let mut failure = None;
    for method in [
        Method::Agent,
        Method::KeyFile,
        Method::Password,
        Method::KeyboardInteractive,
    ] {
        let (name, step) = match method {
            Method::Agent => ("agent", attempt.agent(agent, home_dir).await),
            Method::KeyFile => ("key-file", attempt.key_files(home_dir).await),
            Method::Password => ("password", attempt.password().await),
            Method::KeyboardInteractive => {
                ("keyboard-interactive", attempt.keyboard_interactive().await)
            }
        };
        if let Ok(Step::Failed(error)) | Err(error) = &step {
            log_auth(&host.id, name, error.log_kind());
        }
        match step? {
            Step::Done => return Ok(()),
            Step::Partial => failure = None,
            Step::Failed(e) => failure = Some(e),
            Step::Skipped => {}
        }
    }
    Err(failure.unwrap_or_else(|| ConnectError::NoSupportedMethod {
        methods: attempt
            .allowed
            .iter()
            .map(|m| <&str>::from(m).to_owned())
            .collect(),
    }))
}

fn log_auth(host: &HostId, method: &str, result: &str) {
    log::info!("connection hop={host} authentication method={method} result={result}");
}

fn auth_result<T>(result: &Result<AuthResult, T>) -> &'static str {
    match result {
        Ok(AuthResult::Success) => "accepted",
        Ok(AuthResult::Failure {
            partial_success: true,
            ..
        }) => "partial",
        Ok(AuthResult::Failure { .. }) => "rejected",
        Err(_) => "protocol",
    }
}

#[derive(Clone, Copy)]
enum Method {
    Agent,
    KeyFile,
    Password,
    KeyboardInteractive,
}

impl<H: client::Handler> AuthAttempt<'_, '_, H> {
    fn allows(&self, method: MethodKind) -> bool {
        self.allowed.contains(&method)
    }

    /// Records the server's answer: `Some(step)` when this method is settled.
    fn settle(&mut self, result: AuthResult) -> Option<Step> {
        match result {
            AuthResult::Success => Some(Step::Done),
            AuthResult::Failure {
                remaining_methods,
                partial_success,
            } => {
                self.allowed = remaining_methods;
                partial_success.then_some(Step::Partial)
            }
        }
    }

    async fn rsa_hash(&self) -> Result<Option<HashAlg>, ConnectError> {
        Ok(self.handle.best_supported_rsa_hash().await?.flatten())
    }

    async fn agent(
        &mut self,
        agent: &Agent,
        home_dir: Option<&Path>,
    ) -> Result<Step, ConnectError> {
        if !self.allows(MethodKind::PublicKey) || matches!(agent, Agent::None) {
            return Ok(Step::Skipped);
        }
        self.progress.method(AuthMethod::Agent);
        let Some(mut client) = agent.connect().await else {
            return Ok(Step::Skipped);
        };
        let selected = match (&self.host.auth, self.host.identities_only) {
            (HostAuth::Key { identity_file }, true) => {
                let path = expand_home(identity_file, home_dir);
                let Some(key) = identity_public_key(&path) else {
                    return Ok(Step::Skipped);
                };
                Some(key)
            }
            _ => None,
        };
        let mut identities = client.request_identities().await.unwrap_or_default();
        identities.retain(|identity| {
            let key_data = match identity {
                AgentIdentity::PublicKey { key, .. } => key.key_data(),
                AgentIdentity::Certificate { certificate, .. }
                    if certificate.cert_type().is_user() =>
                {
                    certificate.public_key()
                }
                AgentIdentity::Certificate { .. } => return false,
            };
            // Certificates and plain keys can represent the same selected key.
            // Compare the key data because the comments can differ.
            selected
                .as_ref()
                .is_none_or(|selected| selected.key_data() == key_data)
        });
        if identities.is_empty() {
            return Ok(Step::Skipped);
        }
        // Prefer certificates while preserving the agent's order within each kind.
        identities.sort_by_key(|identity| matches!(identity, AgentIdentity::PublicKey { .. }));
        let rsa_hash = self.rsa_hash().await?;
        for identity in identities {
            log_auth(&self.host.id, "agent", "attempting");
            let result = match identity {
                AgentIdentity::PublicKey { key, .. } => {
                    let hash = key.algorithm().is_rsa().then_some(rsa_hash).flatten();
                    self.handle
                        .authenticate_publickey_with(&self.host.user, key, hash, &mut client)
                        .await
                }
                AgentIdentity::Certificate { certificate, .. } => {
                    let hash = certificate
                        .algorithm()
                        .is_rsa()
                        .then_some(rsa_hash)
                        .flatten();
                    self.handle
                        .authenticate_certificate_with(
                            &self.host.user,
                            certificate,
                            hash,
                            &mut client,
                        )
                        .await
                }
            };
            log_auth(&self.host.id, "agent", auth_result(&result));
            let result = match result {
                Ok(result) => result,
                // The agent would not sign (locked, refused): next key.
                Err(AgentAuthError::Key(_)) => continue,
                Err(AgentAuthError::Send(e)) => return Err(ConnectError::Protocol(e.to_string())),
            };
            if let Some(step) = self.settle(result) {
                return Ok(step);
            }
            if !self.allows(MethodKind::PublicKey) {
                break;
            }
        }
        Ok(Step::Failed(ConnectError::AgentKeysRejected))
    }

    async fn key_files(&mut self, home_dir: Option<&Path>) -> Result<Step, ConnectError> {
        if !self.allows(MethodKind::PublicKey) {
            return Ok(Step::Skipped);
        }
        match &self.host.auth {
            HostAuth::Password => Ok(Step::Skipped),
            HostAuth::Key { identity_file } => {
                let path = expand_home(identity_file, home_dir);
                self.key_file(path, false).await
            }
            HostAuth::Auto => {
                let Some(home_dir) = home_dir else {
                    return Ok(Step::Skipped);
                };
                let ssh_dir = home_dir.join(".ssh");
                let mut last = Step::Skipped;
                for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
                    match self.key_file(ssh_dir.join(name), true).await? {
                        Step::Skipped => {}
                        Step::Done => return Ok(Step::Done),
                        step => last = step,
                    }
                    if !self.allows(MethodKind::PublicKey) {
                        break;
                    }
                }
                Ok(last)
            }
        }
    }

    async fn key_file(&mut self, path: PathBuf, skip_missing: bool) -> Result<Step, ConnectError> {
        // A key file is a few KiB: reading it inline is fine.
        let text = fs::read_to_string(&path);
        if skip_missing && matches!(&text, Err(error) if error.kind() == io::ErrorKind::NotFound) {
            return Ok(Step::Skipped);
        }
        self.progress.method(AuthMethod::KeyFile);
        let text = match text {
            Ok(text) => text,
            Err(error) => {
                return Ok(Step::Failed(ConnectError::KeyUnreadable {
                    path,
                    reason: error.to_string(),
                }));
            }
        };
        log_auth(&self.host.id, "key-file", "attempting");
        let key = match decode_key(text, &path, self.prompter, &self.saved).await? {
            Ok(key) => key,
            Err(e) => return Ok(Step::Failed(e)),
        };
        let rsa_hash = self.rsa_hash().await?;
        let key = Arc::new(key);
        if let Some(certificate) = matching_user_certificate(&path, key.public_key()) {
            log_auth(&self.host.id, "key-certificate", "attempting");
            let result = if let Some(rsa_key) = key.key_data().rsa() {
                // The direct file certificate API cannot select an RSA hash.
                self.handle
                    .authenticate_certificate_with(
                        &self.host.user,
                        certificate,
                        rsa_hash,
                        &mut RsaCertificateSigner(rsa_key),
                    )
                    .await
                    .map_err(|error| match error {
                        AgentAuthError::Key(error) => ConnectError::KeyUnreadable {
                            path: path.clone(),
                            reason: error.to_string(),
                        },
                        AgentAuthError::Send(error) => ConnectError::Protocol(error.to_string()),
                    })
            } else {
                self.handle
                    .authenticate_openssh_cert(&self.host.user, Arc::clone(&key), certificate)
                    .await
                    .map_err(ConnectError::from)
            };
            log_auth(&self.host.id, "key-certificate", auth_result(&result));
            let result = match result {
                Err(error @ ConnectError::KeyUnreadable { .. }) => return Ok(Step::Failed(error)),
                result => result?,
            };
            if let Some(step) = self.settle(result) {
                return Ok(step);
            }
            if !self.allows(MethodKind::PublicKey) {
                return Ok(Step::Failed(ConnectError::KeyRejected { path }));
            }
        }
        let key = PrivateKeyWithHashAlg::new(key, rsa_hash);
        let result = self
            .handle
            .authenticate_publickey(&self.host.user, key)
            .await;
        log_auth(&self.host.id, "key-file", auth_result(&result));
        Ok(self
            .settle(result?)
            .unwrap_or(Step::Failed(ConnectError::KeyRejected { path })))
    }

    async fn password(&mut self) -> Result<Step, ConnectError> {
        if !self.allows(MethodKind::Password) {
            return Ok(Step::Skipped);
        }
        self.progress.method(AuthMethod::Password);
        let mut retry = false;
        if let Some(password) = self.saved.get(CredentialKind::Password).await {
            if let Some(step) = self.try_password(password).await? {
                return Ok(step);
            }
            // Changed on the server: forget it and ask.
            self.saved.delete(CredentialKind::Password).await;
            if !self.allows(MethodKind::Password) {
                return Err(ConnectError::AuthenticationFailed);
            }
            retry = true;
        }
        for attempt in 0..ATTEMPTS {
            let prompt = PasswordPrompt {
                host: self.host.address.clone(),
                user: self.host.user.clone(),
                retry: retry || attempt > 0,
                can_save: self.saved.can_save(),
            };
            let password = self
                .prompter
                .password(prompt)
                .await
                .ok_or(ConnectError::Cancelled)?;
            if let Some(step) = self.try_password(password.value.clone()).await? {
                if password.save {
                    self.saved
                        .set(CredentialKind::Password, password.value)
                        .await;
                }
                return Ok(step);
            }
            if !self.allows(MethodKind::Password) {
                break;
            }
        }
        // A rejected password is final: keyboard-interactive would only ask
        // for it again.
        Err(ConnectError::AuthenticationFailed)
    }

    async fn try_password(&mut self, password: String) -> Result<Option<Step>, ConnectError> {
        log_auth(&self.host.id, "password", "attempting");
        let result = self
            .handle
            .authenticate_password(&self.host.user, password)
            .await;
        log_auth(&self.host.id, "password", auth_result(&result));
        Ok(self.settle(result?))
    }

    async fn keyboard_interactive(&mut self) -> Result<Step, ConnectError> {
        if !self.allows(MethodKind::KeyboardInteractive) {
            return Ok(Step::Skipped);
        }
        self.progress.method(AuthMethod::KeyboardInteractive);
        for _ in 0..ATTEMPTS {
            if !self.allows(MethodKind::KeyboardInteractive) {
                break;
            }
            log_auth(&self.host.id, "keyboard-interactive", "attempting");
            let mut response = self
                .handle
                .authenticate_keyboard_interactive_start(&self.host.user, None)
                .await?;
            loop {
                match response {
                    KeyboardInteractiveAuthResponse::Success => {
                        log_auth(&self.host.id, "keyboard-interactive", "accepted");
                        return Ok(Step::Done);
                    }
                    KeyboardInteractiveAuthResponse::Failure {
                        remaining_methods,
                        partial_success,
                    } => {
                        let result = AuthResult::Failure {
                            remaining_methods,
                            partial_success,
                        };
                        let status = if partial_success {
                            "partial"
                        } else {
                            "rejected"
                        };
                        log_auth(&self.host.id, "keyboard-interactive", status);
                        if let Some(step) = self.settle(result) {
                            return Ok(step);
                        }
                        break;
                    }
                    KeyboardInteractiveAuthResponse::InfoRequest {
                        name,
                        instructions,
                        prompts,
                    } => {
                        let answers = if prompts.is_empty() {
                            Vec::new()
                        } else {
                            let prompt = KeyboardInteractivePrompt {
                                host: self.host.address.clone(),
                                user: self.host.user.clone(),
                                name,
                                instructions,
                                prompts: prompts
                                    .into_iter()
                                    .map(|p| KeyboardInteractiveQuestion {
                                        text: p.prompt,
                                        echo: p.echo,
                                    })
                                    .collect(),
                            };
                            self.prompter
                                .keyboard_interactive(prompt)
                                .await
                                .ok_or(ConnectError::Cancelled)?
                        };
                        response = self
                            .handle
                            .authenticate_keyboard_interactive_respond(answers)
                            .await?;
                    }
                }
            }
        }
        Ok(if self.allows(MethodKind::KeyboardInteractive) {
            Step::Failed(ConnectError::AuthenticationFailed)
        } else {
            Step::Skipped
        })
    }
}

/// Decodes and, if needed, decrypts a private key with the saved passphrase or
/// else by asking for it. The outer error ends the connect (cancelled); the
/// inner one only this method.
async fn decode_key(
    text: String,
    path: &Path,
    prompter: &dyn Prompter,
    saved: &Saved,
) -> Result<Result<PrivateKey, ConnectError>, ConnectError> {
    let unreadable = |reason: String| ConnectError::KeyUnreadable {
        path: path.to_path_buf(),
        reason,
    };
    let text = Arc::new(text);
    let mut passphrase: Option<String> = None;
    // The vault is read only once the key turns out to be encrypted.
    let mut vault_tried = false;
    let mut from_vault = false;
    let mut save = false;
    let mut asked = 0;
    loop {
        let decode = {
            let text = Arc::clone(&text);
            let passphrase = passphrase.clone();
            // Key derivation is deliberately slow: keep it off the
            // async workers.
            tokio::task::spawn_blocking(move || {
                russh::keys::decode_secret_key(&text, passphrase.as_deref())
            })
        };
        let error = match decode.await {
            Ok(Ok(key)) => {
                if let (true, Some(passphrase)) = (save, passphrase) {
                    saved.set(CredentialKind::KeyPassphrase, passphrase).await;
                }
                return Ok(Ok(key));
            }
            Ok(Err(e)) => e,
            Err(e) => return Ok(Err(unreadable(e.to_string()))),
        };
        let wrong = match (&error, &passphrase) {
            (russh::keys::Error::KeyIsEncrypted, None) => false,
            // The encrypted PPK error variant is private to ssh-key.
            (russh::keys::Error::SshKey(ssh_key::Error::Ppk(error)), None)
                if error.to_string() == "private key is encrypted" =>
            {
                false
            }
            (_, Some(_)) if is_wrong_passphrase(&error) => true,
            _ => return Ok(Err(unreadable(error.to_string()))),
        };
        if from_vault {
            // The key's passphrase changed: forget the saved one.
            saved.delete(CredentialKind::KeyPassphrase).await;
            from_vault = false;
        }
        if !vault_tried {
            vault_tried = true;
            if let Some(stored) = saved.get(CredentialKind::KeyPassphrase).await {
                passphrase = Some(stored);
                from_vault = true;
                continue;
            }
        }
        if asked == ATTEMPTS {
            break;
        }
        asked += 1;
        let prompt = PassphrasePrompt {
            key_path: path.to_path_buf(),
            retry: wrong,
            can_save: saved.can_save(),
        };
        let answer = prompter
            .passphrase(prompt)
            .await
            .ok_or(ConnectError::Cancelled)?;
        save = answer.save;
        passphrase = Some(answer.value);
    }
    Ok(Err(ConnectError::KeyPassphraseIncorrect {
        path: path.to_path_buf(),
    }))
}

/// Decrypting with the wrong passphrase yields garbage, which shows up as
/// one of these.
fn is_wrong_passphrase(error: &russh::keys::Error) -> bool {
    use russh::keys::Error::*;
    matches!(
        error,
        KeyIsEncrypted | KeyIsCorrupt | CouldNotReadKey | Unpad(_) | SshKey(_) | Pkcs8(_)
    )
}

/// Reads the identity without prompting for or retrieving a passphrase.
fn identity_public_key(path: &Path) -> Option<PublicKey> {
    let text = fs::read_to_string(path).ok()?;
    let text = text.trim();
    if let Ok(key) = PublicKey::from_openssh(text) {
        return Some(key);
    }
    if let Ok(key) = PrivateKey::from_openssh(text) {
        // The OpenSSH envelope keeps the public key outside the encrypted part.
        return Some(key.public_key().clone());
    }
    match russh::keys::decode_secret_key(text, None) {
        Ok(key) => Some(key.public_key().clone()),
        Err(russh::keys::Error::SshKey(ssh_key::Error::Ppk(error)))
            if error.to_string() == "private key is encrypted" =>
        {
            // ssh-key checked the PPK envelope and its Public-Lines section
            // before requesting a passphrase for the private key.
            let mut public_sections = text.lines().enumerate().filter_map(|(line, value)| {
                value
                    .strip_prefix("Public-Lines: ")
                    .map(|count| (line, count))
            });
            let (header, count) = public_sections.next()?;
            if public_sections.next().is_some() {
                return None;
            }
            let encoded: String = text
                .lines()
                .skip(header + 1)
                .take(count.parse().ok()?)
                .collect();
            russh::keys::parse_public_key_base64(&encoded).ok()
        }
        _ => None,
    }
}

/// OpenSSH appends the certificate suffix to the full file name.
fn matching_user_certificate(path: &Path, key: &PublicKey) -> Option<Certificate> {
    let mut certificate_path = path.as_os_str().to_os_string();
    certificate_path.push("-cert.pub");
    load_openssh_certificate(certificate_path)
        .ok()
        .filter(|certificate| {
            certificate.cert_type().is_user() && certificate.public_key() == key.key_data()
        })
}

struct RsaCertificateSigner<'a>(&'a ssh_key::private::RsaKeypair);

impl Signer for RsaCertificateSigner<'_> {
    type Error = AgentAuthError;

    async fn auth_sign(
        &mut self,
        _: &AgentIdentity,
        hash_alg: Option<HashAlg>,
        mut data: Vec<u8>,
    ) -> Result<Vec<u8>, Self::Error> {
        let signature = signature::Signer::try_sign(&(self.0, hash_alg), &data)
            .map_err(|_| russh::keys::Error::InvalidSignature)?;
        signature
            .encode_prefixed(&mut data)
            .map_err(russh::keys::Error::from)?;
        Ok(data)
    }
}

/// `~/x` → the local home directory's `x`.
fn expand_home(path: &Path, home_dir: Option<&Path>) -> PathBuf {
    match (home_dir, path.strip_prefix("~")) {
        (Some(home_dir), Ok(rest)) => home_dir.join(rest),
        _ => path.to_path_buf(),
    }
}
