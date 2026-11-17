//! SSH Connections. [`ConnectionManager::connect`] returns one shared
//! [`Connection`] per Host; every remote Terminal (and, later, File panel and
//! Port forward) on that Host runs over it.
//!
//! Decisions that need the user (trusting a new host key, typing a password)
//! are delegated to a [`Prompter`], which the app implements with UI dialogs.
//! A changed host key is never put to the user: the connection is refused.
//!
//! A Host behind Jump hosts is reached with
//! [`ConnectionManager::connect_through`]: each hop is its own Connection
//! (verified and authenticated like any other), and the next hop's SSH
//! transport runs inside a `direct-tcpip` channel of the previous one.

mod shell;

pub use shell::RemoteShell;

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::PublicKeyOrCertificate;
use tokio::io::{AsyncRead, AsyncWrite};
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
    /// A hop before the target failed: `name` is that Jump host's name.
    #[error("jump host {name}: {source}")]
    JumpHost {
        name: String,
        #[source]
        source: Box<ConnectError>,
    },
}

impl From<russh::Error> for ConnectError {
    fn from(e: russh::Error) -> Self {
        ConnectError::Protocol(e.to_string())
    }
}

/// Hands out one shared [`Connection`] per Host. A Connection lives while
/// anything (a Terminal, …) holds it, and disconnects when the last holder
/// drops it.
pub struct ConnectionManager {
    known_hosts: KnownHosts,
    config: Arc<client::Config>,
    connections: Mutex<HashMap<HostId, Weak<Connection>>>,
}

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
            connections: Mutex::default(),
        }
    }

    /// The live Connection to `host`, or a new one: verifies the host key
    /// against known_hosts and authenticates, asking `prompter` as needed.
    pub async fn connect(
        &self,
        host: &Host,
        prompter: Arc<dyn Prompter>,
    ) -> Result<Arc<Connection>, ConnectError> {
        self.connect_through(&[], host, prompter).await
    }

    /// Like [`connect`](Self::connect), for a Host reached through
    /// `jump_hosts` (outermost first, as `HostStore::jump_chain` lists them
    /// before the Host itself). Every hop is a shared Connection of its own,
    /// checked against known_hosts and authenticated in turn; a failing hop
    /// is reported as [`ConnectError::JumpHost`] with its name.
    pub async fn connect_through(
        &self,
        jump_hosts: &[Host],
        host: &Host,
        prompter: Arc<dyn Prompter>,
    ) -> Result<Arc<Connection>, ConnectError> {
        let mut via = None;
        for jump in jump_hosts {
            let hop = self.hop(jump, via, prompter.clone()).await;
            via = Some(hop.map_err(|e| ConnectError::JumpHost {
                name: jump.name.clone(),
                source: Box::new(e),
            })?);
        }
        self.hop(host, via, prompter).await
    }

    /// The live Connection to `host`, or a new one opened directly or, with
    /// `via`, through that Jump host's Connection.
    async fn hop(
        &self,
        host: &Host,
        via: Option<Arc<Connection>>,
        prompter: Arc<dyn Prompter>,
    ) -> Result<Arc<Connection>, ConnectError> {
        if let Some(live) = self.live(&host.id) {
            return Ok(live);
        }
        let connection = match via {
            None => {
                let stream = open_tcp(host).await?;
                self.establish(host, stream, prompter, None).await?
            }
            Some(jump) => {
                let stream = jump.open_tunnel(host).await?;
                self.establish(host, stream, prompter, Some(jump)).await?
            }
        };
        let connection = Arc::new(connection);
        let mut connections = self.lock();
        connections.retain(|_, weak| weak.strong_count() > 0);
        connections.insert(host.id.clone(), Arc::downgrade(&connection));
        Ok(connection)
    }

    fn live(&self, id: &HostId) -> Option<Arc<Connection>> {
        self.lock()
            .get(id)
            .and_then(Weak::upgrade)
            .filter(|c| !c.handle.is_closed())
    }

    /// Runs SSH to `host` over `stream`: host key check, then authentication.
    async fn establish<S>(
        &self,
        host: &Host,
        stream: S,
        prompter: Arc<dyn Prompter>,
        via: Option<Arc<Connection>>,
    ) -> Result<Connection, ConnectError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
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
        Ok(Connection { handle, _via: via })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<HostId, Weak<Connection>>> {
        self.connections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

async fn open_tcp(host: &Host) -> Result<TcpStream, ConnectError> {
    let stream = tokio::time::timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((host.address.as_str(), host.port)),
    )
    .await
    .map_err(|_| ConnectError::TimedOut)?
    .map_err(|e| ConnectError::Unreachable(e.to_string()))?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
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
    /// The Jump host's Connection this one is tunnelled through, kept open
    /// for as long as this one is.
    _via: Option<Arc<Connection>>,
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connection")
            .field("closed", &self.handle.is_closed())
            .finish()
    }
}

impl Connection {
    /// A byte stream to `host`'s SSH port, opened by this Connection's server
    /// (a `direct-tcpip` channel, like `ssh -J`).
    async fn open_tunnel(
        &self,
        host: &Host,
    ) -> Result<impl AsyncRead + AsyncWrite + Unpin + Send + 'static, ConnectError> {
        let channel = tokio::time::timeout(
            CONNECT_TIMEOUT,
            self.handle.channel_open_direct_tcpip(
                host.address.as_str(),
                u32::from(host.port),
                "127.0.0.1",
                0,
            ),
        )
        .await
        .map_err(|_| ConnectError::TimedOut)?
        .map_err(|e| ConnectError::Unreachable(format!("{}:{}: {e}", host.address, host.port)))?;
        Ok(channel.into_stream())
    }

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
