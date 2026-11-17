//! User authentication on a fresh SSH transport. Methods are tried in a fixed
//! order, each only while the server still lists it: ssh-agent, the Host's
//! private key file, password, keyboard-interactive. A method the server
//! accepts with "partial success" (e.g. key, then OTP) moves on to the next.
//!
//! When nothing succeeds, the error describes the last method that failed
//! (e.g. a rejected key) so the UI can say why.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use russh::client::{self, AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg};
use russh::{AgentAuthError, MethodKind, MethodSet};

use super::{
    ConnectError, KeyboardInteractivePrompt, KeyboardInteractiveQuestion, PassphrasePrompt,
    PasswordPrompt, Prompter,
};
use crate::hosts::{Host, HostAuth};

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
}

type DynAgent = AgentClient<Box<dyn AgentStream + Send + Unpin + 'static>>;

impl Agent {
    async fn connect(&self) -> Option<DynAgent> {
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

struct Session<'a, H: client::Handler> {
    handle: &'a mut Handle<H>,
    host: &'a Host,
    prompter: &'a dyn Prompter,
    /// Methods the server still accepts.
    allowed: MethodSet,
}

pub(super) async fn authenticate<H: client::Handler>(
    handle: &mut Handle<H>,
    host: &Host,
    agent: &Agent,
    prompter: &dyn Prompter,
) -> Result<(), ConnectError> {
    let allowed = match handle.authenticate_none(&host.user).await? {
        AuthResult::Success => return Ok(()),
        AuthResult::Failure {
            remaining_methods, ..
        } => remaining_methods,
    };
    let mut session = Session {
        handle,
        host,
        prompter,
        allowed,
    };

    let mut failure = None;
    for method in [
        Method::Agent,
        Method::KeyFile,
        Method::Password,
        Method::KeyboardInteractive,
    ] {
        let step = match method {
            Method::Agent => session.agent(agent).await?,
            Method::KeyFile => session.key_file().await?,
            Method::Password => session.password().await?,
            Method::KeyboardInteractive => session.keyboard_interactive().await?,
        };
        match step {
            Step::Done => return Ok(()),
            Step::Partial => failure = None,
            Step::Failed(e) => failure = Some(e),
            Step::Skipped => {}
        }
    }
    Err(failure.unwrap_or_else(|| ConnectError::NoSupportedMethod {
        methods: session
            .allowed
            .iter()
            .map(|m| <&str>::from(m).to_owned())
            .collect(),
    }))
}

#[derive(Clone, Copy)]
enum Method {
    Agent,
    KeyFile,
    Password,
    KeyboardInteractive,
}

impl<H: client::Handler> Session<'_, H> {
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

    async fn agent(&mut self, agent: &Agent) -> Result<Step, ConnectError> {
        if !self.allows(MethodKind::PublicKey) {
            return Ok(Step::Skipped);
        }
        let Some(mut client) = agent.connect().await else {
            return Ok(Step::Skipped);
        };
        let keys: Vec<_> = client
            .request_identities()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|id| match id {
                AgentIdentity::PublicKey { key, .. } => Some(key),
                AgentIdentity::Certificate { .. } => None,
            })
            .collect();
        if keys.is_empty() {
            return Ok(Step::Skipped);
        }
        let rsa_hash = self.rsa_hash().await?;
        for key in keys {
            let hash = key.algorithm().is_rsa().then_some(rsa_hash).flatten();
            let result = match self
                .handle
                .authenticate_publickey_with(&self.host.user, key, hash, &mut client)
                .await
            {
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

    async fn key_file(&mut self) -> Result<Step, ConnectError> {
        let HostAuth::Key { identity_file } = &self.host.auth else {
            return Ok(Step::Skipped);
        };
        if !self.allows(MethodKind::PublicKey) {
            return Ok(Step::Skipped);
        }
        let path = expand_home(identity_file);
        let key = match load_key(&path, self.prompter).await? {
            Ok(key) => key,
            Err(e) => return Ok(Step::Failed(e)),
        };
        let key = PrivateKeyWithHashAlg::new(Arc::new(key), self.rsa_hash().await?);
        let result = self
            .handle
            .authenticate_publickey(&self.host.user, key)
            .await?;
        Ok(self
            .settle(result)
            .unwrap_or(Step::Failed(ConnectError::KeyRejected { path })))
    }

    async fn password(&mut self) -> Result<Step, ConnectError> {
        if !self.allows(MethodKind::Password) {
            return Ok(Step::Skipped);
        }
        for attempt in 0..ATTEMPTS {
            let prompt = PasswordPrompt {
                host: self.host.address.clone(),
                user: self.host.user.clone(),
                retry: attempt > 0,
            };
            let password = self
                .prompter
                .password(prompt)
                .await
                .ok_or(ConnectError::Cancelled)?;
            let result = self
                .handle
                .authenticate_password(&self.host.user, password)
                .await?;
            if let Some(step) = self.settle(result) {
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

    async fn keyboard_interactive(&mut self) -> Result<Step, ConnectError> {
        for _ in 0..ATTEMPTS {
            if !self.allows(MethodKind::KeyboardInteractive) {
                break;
            }
            let mut response = self
                .handle
                .authenticate_keyboard_interactive_start(&self.host.user, None)
                .await?;
            loop {
                match response {
                    KeyboardInteractiveAuthResponse::Success => return Ok(Step::Done),
                    KeyboardInteractiveAuthResponse::Failure {
                        remaining_methods,
                        partial_success,
                    } => {
                        let result = AuthResult::Failure {
                            remaining_methods,
                            partial_success,
                        };
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

/// Reads and, if needed, decrypts a private key, asking for the passphrase.
/// The outer error ends the connect (cancelled); the inner one only this
/// method.
async fn load_key(
    path: &Path,
    prompter: &dyn Prompter,
) -> Result<Result<PrivateKey, ConnectError>, ConnectError> {
    let unreadable = |reason: String| ConnectError::KeyUnreadable {
        path: path.to_path_buf(),
        reason,
    };
    // A key file is a few KiB: reading it inline is fine.
    let text = match std::fs::read_to_string(path) {
        Ok(text) => Arc::new(text),
        Err(e) => return Ok(Err(unreadable(e.to_string()))),
    };
    let mut passphrase: Option<String> = None;
    for attempt in 0..=ATTEMPTS {
        let decode = {
            let text = Arc::clone(&text);
            let passphrase = passphrase.clone();
            // Key derivation (bcrypt) is deliberately slow: keep it off the
            // async workers.
            tokio::task::spawn_blocking(move || {
                russh::keys::decode_secret_key(&text, passphrase.as_deref())
            })
        };
        let error = match decode.await {
            Ok(Ok(key)) => return Ok(Ok(key)),
            Ok(Err(e)) => e,
            Err(e) => return Ok(Err(unreadable(e.to_string()))),
        };
        let wrong = match (&error, &passphrase) {
            (russh::keys::Error::KeyIsEncrypted, None) => false,
            (_, Some(_)) if is_wrong_passphrase(&error) => true,
            _ => return Ok(Err(unreadable(error.to_string()))),
        };
        if attempt == ATTEMPTS {
            break;
        }
        let prompt = PassphrasePrompt {
            key_path: path.to_path_buf(),
            retry: wrong,
        };
        passphrase = Some(
            prompter
                .passphrase(prompt)
                .await
                .ok_or(ConnectError::Cancelled)?,
        );
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

/// `~/x` → `$HOME/x` (`%USERPROFILE%` on Windows).
fn expand_home(path: &Path) -> PathBuf {
    let Ok(rest) = path.strip_prefix("~") else {
        return path.to_path_buf();
    };
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    match home {
        Some(home) => PathBuf::from(home).join(rest),
        None => path.to_path_buf(),
    }
}
