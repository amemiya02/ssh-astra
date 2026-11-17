//! SSH Connections. [`ConnectionManager::connect`] returns one shared
//! [`Connection`] per Host; every remote Terminal, running Port forward and
//! File panel on that Host runs over it.
//!
//! Decisions that need the user (trusting a new host key, typing a password
//! or key passphrase, answering keyboard-interactive questions) are delegated
//! to a [`Prompter`], which the app implements with UI dialogs. A changed host
//! key is never put to the user: the connection is refused.
//!
//! Authentication tries, as far as the server allows: ssh-agent, the Host's
//! private key file, password, keyboard-interactive (see `auth`). A password
//! or key passphrase saved in the CredentialVault is tried before asking.
//!
//! A Host behind Jump hosts is reached with
//! [`ConnectionManager::connect_through`]: each hop is its own Connection
//! (verified and authenticated like any other), and the next hop's SSH
//! transport runs inside a `direct-tcpip` channel of the previous one.
//!
//! Connections send keepalives (every 30 s by default, see
//! [`ConnectionManager::set_keepalive_interval`]) so a silently dead network
//! is noticed. A [`RemoteTerminal`] outlives its Connection dropping: it
//! reconnects and starts a new shell.

mod auth;
mod held;
mod remote_listen;
mod remote_terminal;
mod shell;

pub use auth::Agent;
pub use held::{HeldConnections, HeldEvent};
pub use remote_terminal::{ReconnectPolicy, RemoteTerminal};
pub use shell::RemoteShell;

pub(crate) use remote_listen::RemoteListener;
use remote_listen::Routes;

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::PublicKeyOrCertificate;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

use crate::credentials::{CredentialVault, NoVault};
use crate::files::{FsError, SftpFs};
use crate::hosts::{Host, HostId};
use crate::known_hosts::{HostKey, KnownHost, KnownHosts, KnownHostsError, Verdict};
use crate::terminal::{TerminalEvent, TerminalSize};
use shell::ShellEvent;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_KEEPALIVE_SECONDS: u32 = 30;

/// The `connection` section of the settings file, as the core reads it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ConnectionSettings {
    /// Seconds between keepalives on an idle Connection; 0 sends none. Three
    /// unanswered ones in a row drop the Connection.
    pub keepalive_seconds: u32,
}

impl Default for ConnectionSettings {
    fn default() -> Self {
        Self {
            keepalive_seconds: DEFAULT_KEEPALIVE_SECONDS,
        }
    }
}

impl ConnectionSettings {
    /// The settings file section this is read from.
    pub const SECTION: &'static str = "connection";

    pub fn keepalive_interval(&self) -> Option<Duration> {
        (self.keepalive_seconds > 0).then(|| Duration::from_secs(self.keepalive_seconds.into()))
    }
}

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
    /// The CredentialVault can keep the answer: offer "save".
    pub can_save: bool,
}

/// A request for the passphrase of an encrypted private key file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PassphrasePrompt {
    pub key_path: PathBuf,
    /// The previous passphrase was wrong.
    pub retry: bool,
    /// The CredentialVault can keep the answer: offer "save".
    pub can_save: bool,
}

/// A typed password or passphrase, and whether the user asked to save it in
/// the CredentialVault. It is saved only once it proves right.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret {
    pub value: String,
    pub save: bool,
}

impl Secret {
    /// Use once, do not save.
    pub fn new(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            save: false,
        }
    }

    /// Use, and save it if it works.
    pub fn saved(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            save: true,
        }
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Secret")
            .field("value", &"<redacted>")
            .field("save", &self.save)
            .finish()
    }
}

/// One round of keyboard-interactive authentication (e.g. an OTP code): the
/// server's questions, to be answered in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyboardInteractivePrompt {
    pub host: String,
    pub user: String,
    /// May be empty.
    pub name: String,
    /// May be empty.
    pub instructions: String,
    /// Never empty: rounds without questions are answered without asking.
    pub prompts: Vec<KeyboardInteractiveQuestion>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyboardInteractiveQuestion {
    pub text: String,
    /// Whether the answer may be shown while typed (false for secrets).
    pub echo: bool,
}

/// Asks the user to decide during a connect. Implemented by the UI layer.
/// Every `None` answer means the user cancelled, which cancels the connect.
pub trait Prompter: Send + Sync {
    /// Should this new host key be trusted (and written to known_hosts)?
    fn confirm_host_key(&self, prompt: HostKeyPrompt) -> BoxFuture<'_, bool>;
    /// The password.
    fn password(&self, prompt: PasswordPrompt) -> BoxFuture<'_, Option<Secret>>;
    /// The passphrase of an encrypted private key.
    fn passphrase(&self, prompt: PassphrasePrompt) -> BoxFuture<'_, Option<Secret>> {
        let _ = prompt;
        Box::pin(async { None })
    }
    /// Answers to the server's keyboard-interactive questions, one per
    /// question.
    fn keyboard_interactive(
        &self,
        prompt: KeyboardInteractivePrompt,
    ) -> BoxFuture<'_, Option<Vec<String>>> {
        let _ = prompt;
        Box::pin(async { None })
    }
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
    /// Password or keyboard-interactive answers were rejected.
    #[error("authentication failed")]
    AuthenticationFailed,
    #[error("cannot use the private key {}: {reason}", path.display())]
    KeyUnreadable { path: PathBuf, reason: String },
    #[error("wrong passphrase for the private key {}", path.display())]
    KeyPassphraseIncorrect { path: PathBuf },
    #[error("the server rejected the private key {}", path.display())]
    KeyRejected { path: PathBuf },
    #[error("the server rejected every key in ssh-agent")]
    AgentKeysRejected,
    /// The server allows no method this Host can use (e.g. it wants a key
    /// and none is configured or in the agent).
    #[error("no usable authentication method (the server accepts: {})", methods.join(", "))]
    NoSupportedMethod { methods: Vec<String> },
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
/// drops it. Concurrent connects to the same Host coalesce: the first one
/// connects, the others wait for it and share its Connection.
pub struct ConnectionManager {
    known_hosts: KnownHosts,
    agent: Agent,
    vault: Arc<dyn CredentialVault>,
    /// Read when a Connection opens; changing it leaves open ones as they are.
    keepalive_interval: Mutex<Option<Duration>>,
    slots: Mutex<HashMap<HostId, Arc<Slot>>>,
}

/// A Host's Connection, if any. Its lock is held while connecting, so a
/// second connect to the Host waits for the first instead of racing it.
type Slot = tokio::sync::Mutex<Weak<Connection>>;

impl ConnectionManager {
    /// A manager that does not use any ssh-agent; see [`Self::with_agent`].
    pub fn new(known_hosts: KnownHosts) -> Self {
        Self {
            known_hosts,
            agent: Agent::None,
            vault: Arc::new(NoVault),
            keepalive_interval: Mutex::new(ConnectionSettings::default().keepalive_interval()),
            slots: Mutex::default(),
        }
    }

    /// Offers the keys of `agent` before any other method. The app passes
    /// [`Agent::System`].
    pub fn with_agent(mut self, agent: Agent) -> Self {
        self.agent = agent;
        self
    }

    /// Uses the passwords and key passphrases saved in `vault`, and saves
    /// there what the user asks to. The app passes `credentials::system_vault()`;
    /// without this nothing is saved.
    pub fn with_vault(mut self, vault: Arc<dyn CredentialVault>) -> Self {
        self.vault = vault;
        self
    }

    /// How often Connections opened from now on send a keepalive when
    /// nothing else arrives (`None`: never). Three unanswered keepalives in a
    /// row drop the Connection.
    pub fn set_keepalive_interval(&self, interval: Option<Duration>) {
        *self
            .keepalive_interval
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = interval;
    }

    fn client_config(&self) -> Arc<client::Config> {
        let keepalive_interval = *self
            .keepalive_interval
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        Arc::new(client::Config {
            keepalive_interval,
            keepalive_max: 3,
            inactivity_timeout: None,
            nodelay: true,
            ..Default::default()
        })
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
        self.shared(&host.id, || async move {
            match via {
                None => {
                    let stream = open_tcp(host).await?;
                    self.establish(host, stream, prompter, None).await
                }
                Some(jump) => {
                    let stream = jump.open_tunnel(host).await?;
                    self.establish(host, stream, prompter, Some(jump)).await
                }
            }
        })
        .await
    }

    /// The Host's live Connection, if it has one, without connecting. While
    /// a connect to it is in flight, waits for that one.
    pub async fn live(&self, id: &HostId) -> Option<Arc<Connection>> {
        let slot = self.slot(id);
        let current = slot.lock().await;
        current.upgrade().filter(|c| !c.is_closed())
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
        if let Some(live) = current.upgrade().filter(|c| !c.is_closed()) {
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
        let routes = Routes::default();
        let handler = ClientHandler {
            routes: routes.clone(),
            host: host.address.clone(),
            port: host.port,
            known_hosts: self.known_hosts.clone(),
            prompter: prompter.clone(),
            failure: failure.clone(),
        };
        let mut handle = match client::connect_stream(self.client_config(), stream, handler).await {
            Ok(handle) => handle,
            Err(e) => {
                let recorded = failure.lock().ok().and_then(|mut f| f.take());
                return Err(recorded.unwrap_or_else(|| e.into()));
            }
        };

        auth::authenticate(
            &mut handle,
            host,
            &self.agent,
            &self.vault,
            prompter.as_ref(),
        )
        .await?;
        Ok(Connection {
            handle,
            routes,
            _via: via,
        })
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

/// One live, authenticated SSH transport to a Host.
pub struct Connection {
    handle: Handle<ClientHandler>,
    /// Ports the server listens on for us, and who gets their connections.
    routes: Routes,
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
        tokio::time::timeout(
            CONNECT_TIMEOUT,
            self.open_direct_tcpip(&host.address, host.port, None),
        )
        .await
        .map_err(|_| ConnectError::TimedOut)?
        .map_err(|e| ConnectError::Unreachable(format!("{}:{}: {e}", host.address, host.port)))
    }

    /// A byte stream to `host:port` as this Connection's server sees that
    /// address (a `direct-tcpip` channel). `originator` is the local peer the
    /// stream is opened for, if any.
    pub(crate) async fn open_direct_tcpip(
        &self,
        host: &str,
        port: u16,
        originator: Option<std::net::SocketAddr>,
    ) -> Result<russh::ChannelStream<client::Msg>, russh::Error> {
        let (orig_ip, orig_port) = originator.map_or(("127.0.0.1".to_owned(), 0), |a| {
            (a.ip().to_string(), a.port())
        });
        let channel = self
            .handle
            .channel_open_direct_tcpip(host, u32::from(port), orig_ip, u32::from(orig_port))
            .await?;
        Ok(channel.into_stream())
    }

    /// Whether the transport has ended (the server went away, keepalives
    /// failed, ...).
    pub(crate) fn is_closed(&self) -> bool {
        self.handle.is_closed()
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
        let mut sink = sink;
        self.start_shell(size, move |event| {
            sink(match event {
                ShellEvent::Output(bytes) => TerminalEvent::Output(bytes),
                ShellEvent::Exit { code } => TerminalEvent::Exit { code },
                ShellEvent::Lost => TerminalEvent::Exit { code: None },
            })
        })
        .await
    }

    /// Like [`open_shell`](Self::open_shell), telling a dropped Connection
    /// apart from the shell ending.
    async fn start_shell<F>(
        self: &Arc<Self>,
        size: TerminalSize,
        sink: F,
    ) -> Result<RemoteShell, ConnectError>
    where
        F: FnMut(ShellEvent) + Send + 'static,
    {
        let channel = self.handle.channel_open_session().await?;
        shell::start(Arc::clone(self), channel, size, sink).await
    }

    /// Opens an SFTP session on this Connection, for a File panel. It keeps
    /// the Connection alive while it is open.
    pub async fn open_sftp(self: &Arc<Self>) -> Result<SftpFs, FsError> {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| FsError::Protocol(e.to_string()))?;
        SftpFs::start(Arc::clone(self), channel).await
    }
}

struct ClientHandler {
    routes: Routes,
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

    /// A connection the server accepted on a port it listens on for us goes
    /// to that port's [`RemoteListener`]; with none, it is refused.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        match self.routes.route(connected_port) {
            Some(route) => {
                reply.accept().await;
                let _ = route.send(channel.into_stream());
            }
            None => {
                reply
                    .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                    .await
            }
        }
        Ok(())
    }
}
