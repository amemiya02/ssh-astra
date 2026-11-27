//! SSH Connections. [`ConnectionManager::connect`] returns one shared
//! [`Connection`] per Host; every remote Terminal, running Port forward and
//! File panel on that Host runs over it.
//!
//! Decisions that need the user (trusting a new host key, typing a password
//! or key passphrase, answering keyboard-interactive questions) are delegated
//! to a [`Prompter`], which the app implements with UI dialogs. A changed host
//! key is never put to the user: the connection is refused.
//!
//! Authentication tries, as far as the server allows: ssh-agent, the default
//! or specified private keys, password, keyboard-interactive (see `auth`). A
//! password or key passphrase saved in the CredentialVault is tried before asking.
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

mod agent_forward;
mod auth;
mod exec;
mod handshake;
mod held;
mod host_keys;
mod progress;
mod remote_listen;
mod remote_terminal;
mod shell;

pub use auth::Agent;
pub use exec::{shell_quote, ExecError, ExecOutput};
pub use held::{HeldConnections, HeldEvent};
pub use host_keys::HostKeyRecord;
pub use progress::{AuthMethod, ConnectProgress, ConnectStage, ProgressStatus};
pub use remote_terminal::{ReconnectPolicy, RemoteTerminal, RemoteTerminalOptions};
pub use shell::RemoteShell;

use agent_forward::AgentForwarding;
use host_keys::{Endpoint, HostKeys};
use progress::HopProgress;
pub(crate) use remote_listen::RemoteListener;
use remote_listen::Routes;

use std::collections::HashMap;
use std::future::Future;
use std::net::Ipv6Addr;
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
use crate::hosts::{Host, HostAuth, HostDraft, HostId, HostStoreError};
use crate::known_hosts::{KnownHosts, KnownHostsError};
use crate::terminal::{TerminalEvent, TerminalSize};
use shell::ShellEvent;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the SSH handshake and authentication may wait on the server, not
/// counting time the user spends answering prompts.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// Unanswered keepalives in a row that drop a Connection.
const KEEPALIVE_MAX: usize = 3;
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

/// How to handle a previously unknown host key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostKeyDecision {
    SaveAndTrust,
    TrustForRun,
    Reject,
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

/// Asks the user to decide and reports progress during a connect.
/// Every `None` answer means the user cancelled, which cancels the connect.
pub trait Prompter: Send + Sync {
    /// Reports progress without waiting for a reply.
    fn progress(&self, _progress: ConnectProgress) {}

    /// How to trust this new host key, if at all.
    fn confirm_host_key(&self, prompt: HostKeyPrompt) -> BoxFuture<'_, HostKeyDecision>;
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
    #[error("the host key for {host}:{port} has changed (now {fingerprint}, recorded {known})")]
    HostKeyMismatch {
        host: String,
        port: u16,
        fingerprint: String,
        known: HostKeyRecord,
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

impl ConnectError {
    /// Stable errors for logs. Protocol errors can contain peer-supplied text.
    fn log_kind(&self) -> &'static str {
        match self {
            Self::Unreachable(_) => "unreachable",
            Self::TimedOut => "timedOut",
            Self::HostKeyMismatch { .. } => "hostKeyMismatch",
            Self::HostKeyRevoked { .. } => "hostKeyRevoked",
            Self::HostKeyDeclined => "hostKeyDeclined",
            Self::HostCertificateUnsupported => "hostCertificateUnsupported",
            Self::KnownHosts(_) => "knownHosts",
            Self::AuthenticationFailed => "authenticationFailed",
            Self::KeyUnreadable { .. } => "keyUnreadable",
            Self::KeyPassphraseIncorrect { .. } => "keyPassphraseIncorrect",
            Self::KeyRejected { .. } => "keyRejected",
            Self::AgentKeysRejected => "agentKeysRejected",
            Self::NoSupportedMethod { .. } => "noSupportedMethod",
            Self::Cancelled => "cancelled",
            Self::Protocol(_) => "protocol",
            Self::JumpHost { source, .. } => source.log_kind(),
        }
    }
}

fn log_hop<T>(id: &HostId, step: &str, result: &Result<T, ConnectError>) {
    match result {
        Ok(_) => log::info!("connection hop={id} step={step} result=success"),
        Err(error) => log::warn!(
            "connection hop={id} step={step} result={}",
            error.log_kind()
        ),
    }
}

/// Hands out one shared [`Connection`] per Host. A Connection lives while
/// anything (a Terminal, …) holds it, and disconnects when the last holder
/// drops it. Concurrent connects to the same Host coalesce: the first one
/// connects, the others wait for it and share its Connection.
/// Saved Hosts' temporary key trust lasts for the lifetime of the manager.
pub struct ConnectionManager {
    host_keys: Arc<HostKeys>,
    agent: Agent,
    home_dir: Option<PathBuf>,
    vault: Arc<dyn CredentialVault>,
    /// Read when a Connection opens; changing it leaves open ones as they are.
    keepalive_interval: Mutex<Option<Duration>>,
    handshake_timeout: Duration,
    slots: Mutex<HashMap<HostId, Arc<Slot>>>,
    /// Each Host's shared SFTP session ([`Self::live_sftp`]), kept only while
    /// something holds it and tied to the Connection it was opened on.
    sftp: tokio::sync::Mutex<HashMap<HostId, SharedSftp>>,
}

/// A Host's shared SFTP session and the Connection it runs on.
type SharedSftp = (Weak<Connection>, Weak<SftpFs>);

/// A Host's Connection, if any. Its lock is held while connecting, so a
/// second connect to the Host waits for the first instead of racing it.
type Slot = tokio::sync::Mutex<Weak<Connection>>;

/// An SSH destination supplied by Quick connect. An omitted user means the local user.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickConnectTarget {
    pub address: String,
    pub port: u16,
    pub user: Option<String>,
}

/// Ephemeral connection settings and key trust, held while their tabs are open.
pub struct TemporaryHost {
    host: Host,
    keys: Arc<HostKeys>,
}

impl TemporaryHost {
    pub fn host(&self) -> &Host {
        &self.host
    }
}

#[derive(Clone, Copy)]
enum ConnectionPurpose<'a> {
    Shared,
    Temporary(&'a Arc<HostKeys>),
    Test,
}

impl ConnectionManager {
    /// A manager that does not use any ssh-agent; see [`Self::with_agent`].
    pub fn new(known_hosts: KnownHosts) -> Self {
        Self {
            host_keys: Arc::new(HostKeys::new(known_hosts)),
            agent: Agent::None,
            home_dir: std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from),
            vault: Arc::new(NoVault),
            keepalive_interval: Mutex::new(ConnectionSettings::default().keepalive_interval()),
            handshake_timeout: HANDSHAKE_TIMEOUT,
            slots: Mutex::default(),
            sftp: tokio::sync::Mutex::default(),
        }
    }

    /// Offers the keys of `agent` before any other method. The app passes
    /// [`Agent::System`].
    pub fn with_agent(mut self, agent: Agent) -> Self {
        self.agent = agent;
        self
    }

    /// Resolves default key paths and `~/` in private key paths against `home_dir`.
    pub fn with_home_dir(mut self, home_dir: impl Into<PathBuf>) -> Self {
        self.home_dir = Some(home_dir.into());
        self
    }

    /// Uses the passwords and key passphrases saved in `vault`, and saves
    /// there what the user asks to. The app passes `credentials::system_vault()`;
    /// without this nothing is saved.
    pub fn with_vault(mut self, vault: Arc<dyn CredentialVault>) -> Self {
        self.vault = vault;
        self
    }

    /// How long the SSH handshake and authentication of each hop may wait on
    /// the server (20 s by default); time spent in prompts does not count.
    /// Running out fails the connect with [`ConnectError::TimedOut`].
    pub fn with_handshake_timeout(mut self, timeout: Duration) -> Self {
        self.handshake_timeout = timeout;
        self
    }

    /// The default interval for new Connections whose Hosts inherit it
    /// (`None`: never). Three unanswered keepalives in a row drop the Connection.
    pub fn set_keepalive_interval(&self, interval: Option<Duration>) {
        *self
            .keepalive_interval
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = interval;
    }

    fn client_config(&self, host: &Host) -> Arc<client::Config> {
        let keepalive_interval = match host.keepalive_seconds {
            Some(0) => None,
            Some(seconds) => Some(Duration::from_secs(u64::from(seconds))),
            None => *self
                .keepalive_interval
                .lock()
                .unwrap_or_else(|p| p.into_inner()),
        };
        Arc::new(client::Config {
            keepalive_interval,
            keepalive_max: KEEPALIVE_MAX,
            // A backstop behind the keepalives (which a live server answers):
            // nothing at all received for this long drops the Connection.
            // Off with keepalives off, so an idle Connection stays.
            inactivity_timeout: keepalive_interval.map(|k| k * (KEEPALIVE_MAX as u32 + 2)),
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
        self.connect_route(jump_hosts, host, prompter, ConnectionPurpose::Shared)
            .await
    }

    /// Allocates a fresh identity without touching the Host store or credential vault.
    pub fn temporary_host(
        &self,
        target: QuickConnectTarget,
        local_user: &str,
    ) -> Result<TemporaryHost, HostStoreError> {
        let QuickConnectTarget {
            address,
            port,
            user,
        } = target;
        let user = user.unwrap_or_else(|| local_user.to_owned());
        let endpoint = if address.contains(':') {
            address
                .parse::<Ipv6Addr>()
                .map_err(|_| HostStoreError::Invalid("address"))?;
            format!("[{address}]")
        } else if address
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
        {
            address.clone()
        } else {
            return Err(HostStoreError::Invalid("address"));
        };
        let name = if port == 22 {
            format!("{user}@{endpoint}")
        } else {
            format!("{user}@{endpoint}:{port}")
        };
        let host = HostDraft {
            name,
            address,
            port,
            user,
            auth: HostAuth::Auto,
            identities_only: false,
            forward_agent: false,
            keepalive_seconds: None,
            post_login_command: None,
            terminal_charset: None,
            terminal_backspace: None,
            jump_host: None,
            terminal_scheme: None,
            default_directory: None,
        }
        .into_host(HostId::generate())?;
        Ok(TemporaryHost {
            host,
            keys: Arc::new(self.host_keys.scoped()),
        })
    }

    /// Shares the Temporary Host's live Connection, with key trust scoped to
    /// this Host and no credential lookup or saving.
    pub async fn connect_temporary(
        &self,
        temporary: &TemporaryHost,
        prompter: Arc<dyn Prompter>,
    ) -> Result<Arc<Connection>, ConnectError> {
        self.connect_route(
            &[],
            temporary.host(),
            prompter,
            ConnectionPurpose::Temporary(&temporary.keys),
        )
        .await
    }

    /// Authenticates on a private Connection at every hop, without using the
    /// credential vault or opening a shell, then closes the route.
    pub async fn test_connection(
        &self,
        jump_hosts: &[Host],
        host: &Host,
        prompter: Arc<dyn Prompter>,
    ) -> Result<(), ConnectError> {
        let connection = self
            .connect_route(jump_hosts, host, prompter, ConnectionPurpose::Test)
            .await?;
        // Disconnect from the target back out through its Jump hosts. The
        // timeout bounds shutdown if a transport stops responding after login.
        let _ = tokio::time::timeout(CONNECT_TIMEOUT, disconnect_route(connection)).await;
        Ok(())
    }

    async fn connect_route(
        &self,
        jump_hosts: &[Host],
        host: &Host,
        prompter: Arc<dyn Prompter>,
        purpose: ConnectionPurpose<'_>,
    ) -> Result<Arc<Connection>, ConnectError> {
        let mut via = None;
        for jump in jump_hosts {
            let hop = self.hop(jump, via, prompter.clone(), true, purpose).await;
            via = Some(hop.map_err(|e| ConnectError::JumpHost {
                name: jump.name.clone(),
                source: Box::new(e),
            })?);
        }
        self.hop(host, via, prompter, false, purpose).await
    }

    /// The live Connection to `host`, or a new one opened directly or, with
    /// `via`, through that Jump host's Connection.
    async fn hop(
        &self,
        host: &Host,
        via: Option<Arc<Connection>>,
        prompter: Arc<dyn Prompter>,
        jump_host: bool,
        purpose: ConnectionPurpose<'_>,
    ) -> Result<Arc<Connection>, ConnectError> {
        let progress = HopProgress {
            host,
            jump_host,
            prompter: prompter.as_ref(),
        };
        if !matches!(purpose, ConnectionPurpose::Temporary(_)) {
            log::info!(
                "connection identity {}",
                serde_json::json!({
                    "id": host.id, "name": host.name, "address": host.address, "user": host.user,
                    "port": host.port,
                })
            );
        }
        let open = || async {
            let reach = progress.start(ConnectStage::Reach);
            match via {
                None => {
                    log::info!("connection hop={} step=tcp result=starting", host.id);
                    let stream = open_tcp(host).await;
                    log_hop(&host.id, "tcp", &stream);
                    self.establish(
                        progress,
                        reach.finish(stream)?,
                        prompter.clone(),
                        None,
                        purpose,
                    )
                    .await
                }
                Some(jump) => {
                    log::info!(
                        "connection hop={} step=jump-tunnel result=starting",
                        host.id
                    );
                    let stream = jump.open_tunnel(host).await;
                    log_hop(&host.id, "jump-tunnel", &stream);
                    self.establish(
                        progress,
                        reach.finish(stream)?,
                        prompter.clone(),
                        Some(jump),
                        purpose,
                    )
                    .await
                }
            }
        };
        let result = match purpose {
            ConnectionPurpose::Shared | ConnectionPurpose::Temporary(_) => {
                self.shared(progress, open).await
            }
            ConnectionPurpose::Test => open().await.map(Arc::new),
        };
        log_hop(&host.id, "connect", &result);
        result
    }

    /// The Host's live Connection, if it has one, without connecting. While
    /// a connect to it is in flight, waits for that one.
    pub async fn live(&self, id: &HostId) -> Option<Arc<Connection>> {
        let slot = self.slot(id);
        let current = slot.lock().await;
        current.upgrade().filter(|c| !c.is_closed())
    }

    /// A new SFTP session of its own on the Host's live Connection (a File
    /// panel's, so browsing never waits behind a transfer). Never connects:
    /// [`FsError::NotConnected`] if the Host has no Connection.
    pub async fn open_sftp(&self, id: &HostId) -> Result<SftpFs, FsError> {
        let connection = self.live(id).await.ok_or(FsError::NotConnected)?;
        connection.open_sftp().await
    }

    /// The Host's shared SFTP session on its live Connection, for transfers
    /// and remote edits: opened on first use and handed out again while
    /// anything holds it and its Connection is the live one, so a reconnect
    /// gets a new session. Never connects ([`FsError::NotConnected`]).
    pub async fn live_sftp(&self, id: &HostId) -> Result<Arc<SftpFs>, FsError> {
        let connection = self.live(id).await.ok_or(FsError::NotConnected)?;
        let mut sessions = self.sftp.lock().await;
        sessions.retain(|_, (on, session)| on.strong_count() > 0 && session.strong_count() > 0);
        if let Some((on, session)) = sessions.get(id) {
            if let (Some(on), Some(session)) = (on.upgrade(), session.upgrade()) {
                if Arc::ptr_eq(&on, &connection) {
                    return Ok(session);
                }
            }
        }
        let session = Arc::new(connection.open_sftp().await?);
        sessions.insert(
            id.clone(),
            (Arc::downgrade(&connection), Arc::downgrade(&session)),
        );
        Ok(session)
    }

    /// The live Connection in the Host's slot, or the one `establish` opens,
    /// which is then kept there for later connects.
    async fn shared<F, Fut>(
        &self,
        progress: HopProgress<'_>,
        establish: F,
    ) -> Result<Arc<Connection>, ConnectError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Connection, ConnectError>>,
    {
        let id = &progress.host.id;
        let slot = self.slot(id);
        let mut current = match slot.try_lock() {
            Ok(current) => current,
            Err(_) => {
                let waiting = progress.start(ConnectStage::Waiting);
                let current = slot.lock().await;
                waiting.end(ProgressStatus::Succeeded);
                current
            }
        };
        if let Some(live) = current.upgrade().filter(|c| !c.is_closed()) {
            log::info!("connection hop={id} step=connect result=reused");
            progress.reused();
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

    /// Runs SSH to `host` over `stream`: host key check, then authentication,
    /// within the handshake timeout (which stops while a prompt is open).
    async fn establish<S>(
        &self,
        progress: HopProgress<'_>,
        stream: S,
        prompter: Arc<dyn Prompter>,
        via: Option<Arc<Connection>>,
        purpose: ConnectionPurpose<'_>,
    ) -> Result<Connection, ConnectError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let deadline = handshake::Deadline::new(self.handshake_timeout);
        let prompter: Arc<dyn Prompter> = Arc::new(handshake::Paused {
            inner: prompter,
            deadline: Arc::clone(&deadline),
        });
        let work = self.handshake(
            progress,
            stream,
            prompter,
            via,
            Arc::clone(&deadline),
            purpose,
        );
        handshake::within(&deadline, work)
            .await
            .unwrap_or(Err(ConnectError::TimedOut))
    }

    async fn handshake<S>(
        &self,
        progress: HopProgress<'_>,
        stream: S,
        prompter: Arc<dyn Prompter>,
        via: Option<Arc<Connection>>,
        deadline: Arc<handshake::Deadline>,
        purpose: ConnectionPurpose<'_>,
    ) -> Result<Connection, ConnectError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let host = progress.host;
        let host_key = progress.start(ConnectStage::HostKey);
        let failure = Arc::new(Mutex::new(None));
        let routes = Routes::default();
        let agent_forwarding = (matches!(purpose, ConnectionPurpose::Shared)
            && host.forward_agent
            && self.agent != Agent::None)
            .then(|| Arc::new(AgentForwarding::new(self.agent.clone())));
        let endpoint = Arc::new(Endpoint {
            id: host.id.clone(),
            address: host.address.clone(),
            port: host.port,
            via: via.as_ref().map(|jump| Arc::clone(&jump.endpoint)),
        });
        let handler = ClientHandler {
            routes: routes.clone(),
            agent_forwarding: agent_forwarding.clone(),
            endpoint: Arc::clone(&endpoint),
            host_keys: match purpose {
                ConnectionPurpose::Temporary(keys) => Arc::clone(keys),
                _ => Arc::clone(&self.host_keys),
            },
            prompter: prompter.clone(),
            failure: failure.clone(),
        };
        log::info!("connection hop={} step=handshake result=starting", host.id);
        let handshake = client::connect_stream(self.client_config(host), stream, handler)
            .await
            .map_err(|error| {
                let recorded = failure.lock().ok().and_then(|mut f| f.take());
                recorded.unwrap_or_else(|| error.into())
            });
        log_hop(&host.id, "handshake", &handshake);
        let mut handle = host_key.finish(handshake)?;

        let mut login = progress.start(ConnectStage::Authenticate);
        let vault: Arc<dyn CredentialVault> = match purpose {
            ConnectionPurpose::Shared => Arc::clone(&self.vault),
            ConnectionPurpose::Temporary(_) | ConnectionPurpose::Test => Arc::new(NoVault),
        };
        let authenticated = auth::authenticate(
            &mut handle,
            host,
            auth::AuthSources {
                agent: &self.agent,
                home_dir: self.home_dir.as_deref(),
                vault: &vault,
            },
            prompter.as_ref(),
            deadline,
            &mut login,
        )
        .await;
        log_hop(&host.id, "authentication", &authenticated);
        login.finish(authenticated)?;
        // Different Jump routes and accounts may expose different files
        // at the same SFTP path, including when the server uses chroots.
        let file_namespace = format!(
            "{}{:?}@{:?}:{};",
            via.as_ref().map_or("", |jump| jump.file_namespace()),
            host.user,
            host.address,
            host.port,
        );
        Ok(Connection {
            handle,
            endpoint,
            routes,
            agent_forwarding,
            file_namespace,
            _via: via,
        })
    }
}

async fn disconnect_route(mut connection: Arc<Connection>) {
    // Private connections have one owner: the next hop, or the test itself.
    while let Some(Connection {
        handle, _via: via, ..
    }) = Arc::into_inner(connection)
    {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
        let _ = handle.await;
        let Some(jump) = via else { break };
        connection = jump;
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
    endpoint: Arc<Endpoint>,
    file_namespace: String,
    /// Ports the server listens on for us, and who gets their connections.
    routes: Routes,
    agent_forwarding: Option<Arc<AgentForwarding>>,
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
    pub(crate) fn file_namespace(&self) -> &str {
        &self.file_namespace
    }

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
        let mut channel = self.handle.channel_open_session().await?;
        if let Some(forwarding) = &self.agent_forwarding {
            forwarding
                .request(&mut channel, self.handle.agent_session_binding())
                .await?;
        }
        shell::start(Arc::clone(self), channel, size, sink).await
    }

    /// Opens an SFTP session on this Connection, for a File panel. It keeps
    /// the Connection alive while it is open.
    pub async fn open_sftp(self: &Arc<Self>) -> Result<SftpFs, FsError> {
        let channel = self
            .open_session_channel()
            .await
            .map_err(|e| FsError::Protocol(e.to_string()))?;
        SftpFs::start(Arc::clone(self), channel).await
    }

    pub(crate) async fn open_session_channel(
        &self,
    ) -> Result<russh::Channel<russh::client::Msg>, russh::Error> {
        self.handle.channel_open_session().await
    }
}

struct ClientHandler {
    routes: Routes,
    agent_forwarding: Option<Arc<AgentForwarding>>,
    endpoint: Arc<Endpoint>,
    host_keys: Arc<HostKeys>,
    prompter: Arc<dyn Prompter>,
    /// Why the host key was refused, read back once `connect` fails.
    failure: Arc<Mutex<Option<ConnectError>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        log::info!(
            "connection hop={} step=host-key result=checking",
            self.endpoint.id
        );
        let result = self
            .host_keys
            .verify(&self.endpoint, key, self.prompter.as_ref())
            .await;
        log_hop(&self.endpoint.id, "host-key", &result);
        match result {
            Ok(()) => Ok(true),
            Err(e) => {
                if let Ok(mut failure) = self.failure.lock() {
                    *failure = Some(e);
                }
                Ok(false)
            }
        }
    }

    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if let Some(forwarding) = &self.agent_forwarding {
            forwarding.open(channel, reply).await;
        } else {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
        }
        Ok(())
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
