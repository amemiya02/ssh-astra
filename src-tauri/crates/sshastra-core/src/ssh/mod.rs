//! SSH Connections. [`ConnectionManager::connect`] returns one shared
//! [`Connection`] per Host; every remote Terminal (and, later, File panel and
//! Port forward) on that Host runs over it.
//!
//! Decisions that need the user (trusting a new host key, typing a password)
//! are delegated to a [`Prompter`], which the app implements with UI dialogs.
//! A changed host key is never put to the user: the connection is refused.

mod shell;

pub use shell::RemoteShell;

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::PublicKeyOrCertificate;
use tokio::net::TcpStream;

use crate::hosts::{Host, HostId};
use crate::known_hosts::{HostKey, KnownHost, KnownHosts, KnownHostsError, Verdict};
use crate::terminal::{TerminalEvent, TerminalSize};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
const PASSWORD_ATTEMPTS: usize = 3;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A server key not yet in known_hosts, put to the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKeyPrompt {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    /// `SHA256:…`
    pub fingerprint: String,
}

/// A request for the password of `user@host`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasswordPrompt {
    pub host: String,
    pub user: String,
    /// The previous password was rejected.
    pub retry: bool,
}

/// Asks the user to decide during a connect. Implemented by the UI layer.
pub trait Prompter: Send + Sync {
    /// Should this new host key be trusted (and written to known_hosts)?
    fn confirm_host_key(&self, prompt: HostKeyPrompt) -> BoxFuture<'_, bool>;
    /// The password, or `None` if the user cancelled.
    fn password(&self, prompt: PasswordPrompt) -> BoxFuture<'_, Option<String>>;
}

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("cannot reach the host: {0}")]
    Unreachable(String),
    #[error("the host did not answer in time")]
    TimedOut,
    /// The server's key differs from the one recorded: possibly an attack.
    #[error(
        "the host key for {host}:{port} has changed (now {fingerprint}, recorded \
         {} in {} line {})",
        known.fingerprint,
        known.path.display(),
        known.line
    )]
    HostKeyMismatch {
        host: String,
        port: u16,
        fingerprint: String,
        known: KnownHost,
    },
    #[error("the host key {fingerprint} is marked as revoked")]
    HostKeyRevoked { fingerprint: String },
    #[error("the host key was not trusted")]
    HostKeyDeclined,
    #[error("host certificates are not supported yet")]
    HostCertificateUnsupported,
    #[error(transparent)]
    KnownHosts(#[from] KnownHostsError),
    #[error("authentication failed")]
    AuthenticationFailed,
    #[error("cancelled")]
    Cancelled,
    #[error("SSH error: {0}")]
    Protocol(String),
}

impl From<russh::Error> for ConnectError {
    fn from(e: russh::Error) -> Self {
        ConnectError::Protocol(e.to_string())
    }
}

/// Hands out one shared [`Connection`] per Host. A Connection lives while
/// anything (a Terminal, …) holds it, and disconnects when the last holder
/// drops it. Concurrent connects to the same Host coalesce: the first one
/// connects, the others wait for it and share its Connection.
pub struct ConnectionManager {
    known_hosts: KnownHosts,
    config: Arc<client::Config>,
    slots: Mutex<HashMap<HostId, Arc<Slot>>>,
}

/// A Host's Connection, if any. Its lock is held while connecting, so a
/// second connect to the Host waits for the first instead of racing it.
type Slot = tokio::sync::Mutex<Weak<Connection>>;

impl ConnectionManager {
    pub fn new(known_hosts: KnownHosts) -> Self {
        let config = client::Config {
            keepalive_interval: Some(KEEPALIVE_INTERVAL),
            keepalive_max: 3,
            inactivity_timeout: None,
            nodelay: true,
            ..Default::default()
        };
        Self {
            known_hosts,
            config: Arc::new(config),
            slots: Mutex::default(),
        }
    }

    /// The live Connection to `host`, or a new one: verifies the host key
    /// against known_hosts and authenticates, asking `prompter` as needed.
    /// While another connect to `host` is in flight this waits for it and
    /// shares its Connection; if that one fails, this one tries itself.
    pub async fn connect(
        &self,
        host: &Host,
        prompter: Arc<dyn Prompter>,
    ) -> Result<Arc<Connection>, ConnectError> {
        self.shared(&host.id, || self.establish(host, prompter))
            .await
    }

    /// The live Connection in `id`'s slot, or the one `establish` opens,
    /// which is then kept there for later connects.
    async fn shared<F, Fut>(
        &self,
        id: &HostId,
        establish: F,
    ) -> Result<Arc<Connection>, ConnectError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Connection, ConnectError>>,
    {
        let slot = self.slot(id);
        let mut current = slot.lock().await;
        if let Some(live) = current.upgrade().filter(|c| !c.handle.is_closed()) {
            return Ok(live);
        }
        let connection = Arc::new(establish().await?);
        *current = Arc::downgrade(&connection);
        Ok(connection)
    }

    /// `id`'s slot, created on first use. Slots of Hosts with no Connection
    /// and no connect in flight are dropped on the way.
    fn slot(&self, id: &HostId) -> Arc<Slot> {
        let mut slots = self.slots.lock().unwrap_or_else(|p| p.into_inner());
        slots.retain(|_, slot| {
            Arc::strong_count(slot) > 1
                || slot.try_lock().map_or(true, |weak| weak.strong_count() > 0)
        });
        Arc::clone(slots.entry(id.clone()).or_default())
    }

    async fn establish(
        &self,
        host: &Host,
        prompter: Arc<dyn Prompter>,
    ) -> Result<Connection, ConnectError> {
        let stream = tokio::time::timeout(
            CONNECT_TIMEOUT,
            TcpStream::connect((host.address.as_str(), host.port)),
        )
        .await
        .map_err(|_| ConnectError::TimedOut)?
        .map_err(|e| ConnectError::Unreachable(e.to_string()))?;
        let _ = stream.set_nodelay(true);

        let failure = Arc::new(Mutex::new(None));
        let handler = ClientHandler {
            host: host.address.clone(),
            port: host.port,
            known_hosts: self.known_hosts.clone(),
            prompter: prompter.clone(),
            failure: failure.clone(),
        };
        let mut handle = match client::connect_stream(self.config.clone(), stream, handler).await {
            Ok(handle) => handle,
            Err(e) => {
                let recorded = failure.lock().ok().and_then(|mut f| f.take());
                return Err(recorded.unwrap_or_else(|| e.into()));
            }
        };

        authenticate_with_password(&mut handle, host, prompter.as_ref()).await?;
        Ok(Connection { handle })
    }
}

async fn authenticate_with_password(
    handle: &mut Handle<ClientHandler>,
    host: &Host,
    prompter: &dyn Prompter,
) -> Result<(), ConnectError> {
    for attempt in 0..PASSWORD_ATTEMPTS {
        let prompt = PasswordPrompt {
            host: host.address.clone(),
            user: host.user.clone(),
            retry: attempt > 0,
        };
        let password = prompter
            .password(prompt)
            .await
            .ok_or(ConnectError::Cancelled)?;
        if handle
            .authenticate_password(&host.user, password)
            .await?
            .success()
        {
            return Ok(());
        }
    }
    Err(ConnectError::AuthenticationFailed)
}

/// One live, authenticated SSH transport to a Host.
pub struct Connection {
    handle: Handle<ClientHandler>,
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connection")
            .field("closed", &self.handle.is_closed())
            .finish()
    }
}

impl Connection {
    /// Opens an interactive shell (a remote Terminal) with a PTY of `size`.
    /// The Terminal keeps this Connection alive while it is open.
    pub async fn open_shell<F>(
        self: &Arc<Self>,
        size: TerminalSize,
        sink: F,
    ) -> Result<RemoteShell, ConnectError>
    where
        F: FnMut(TerminalEvent) + Send + 'static,
    {
        let channel = self.handle.channel_open_session().await?;
        shell::start(Arc::clone(self), channel, size, sink).await
    }
}

struct ClientHandler {
    host: String,
    port: u16,
    known_hosts: KnownHosts,
    prompter: Arc<dyn Prompter>,
    /// Why the host key was refused, read back once `connect` fails.
    failure: Arc<Mutex<Option<ConnectError>>>,
}

impl ClientHandler {
    async fn decide(&self, key: &PublicKeyOrCertificate) -> Result<(), ConnectError> {
        let key = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => HostKey::from(key.clone()),
            PublicKeyOrCertificate::Certificate(_) => {
                return Err(ConnectError::HostCertificateUnsupported)
            }
        };
        match self.known_hosts.verify(&self.host, self.port, &key)? {
            Verdict::Match => Ok(()),
            Verdict::Mismatch(known) => Err(ConnectError::HostKeyMismatch {
                host: self.host.clone(),
                port: self.port,
                fingerprint: key.fingerprint(),
                known,
            }),
            Verdict::Revoked => Err(ConnectError::HostKeyRevoked {
                fingerprint: key.fingerprint(),
            }),
            Verdict::Unknown => {
                let prompt = HostKeyPrompt {
                    host: self.host.clone(),
                    port: self.port,
                    algorithm: key.algorithm(),
                    fingerprint: key.fingerprint(),
                };
                if !self.prompter.confirm_host_key(prompt).await {
                    return Err(ConnectError::HostKeyDeclined);
                }
                self.known_hosts.accept(&self.host, self.port, &key)?;
                Ok(())
            }
        }
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        match self.decide(key).await {
            Ok(()) => Ok(true),
            Err(e) => {
                if let Ok(mut failure) = self.failure.lock() {
                    *failure = Some(e);
                }
                Ok(false)
            }
        }
    }
}
