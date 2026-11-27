//! One Connection per Host, counted from the server's side: Terminals share
//! it, concurrent connects coalesce into it, and it is disconnected once the
//! last Terminal or running Port forward on it closes. Runs against the
//! `counted` sshd in Docker, which nothing else connects to (see `support`),
//! and the `jump` sshd, which no other test connects to while this binary
//! runs.

mod support;

use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use sshastra_core::credentials::{CredentialKind, CredentialVault, MemoryVault};
use sshastra_core::files::RemoteFs;
use sshastra_core::forward::{ForwardId, ForwardKind, PortForward, PortForwarder};
use sshastra_core::hosts::{Host, HostAuth, HostDraft, HostId, HostStore};
use sshastra_core::known_hosts::{KnownHosts, Verdict};
use sshastra_core::ssh::{
    BoxFuture, ConnectError, Connection, ConnectionManager, HeldConnections, HostKeyDecision,
    HostKeyPrompt, PasswordPrompt, Prompter, Secret,
};
use sshastra_core::terminal::{Terminal, TerminalEvent, TerminalSize};
use support::{Service, Sshd};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, Notify};

/// The tests count the server's connections, so they take turns.
static SERVER: Mutex<()> = Mutex::const_new(());

/// Trusts the host key and answers every password prompt, recording the
/// address each was for.
struct CountingPrompter {
    password: &'static str,
    asked_for: StdMutex<Vec<String>>,
}

impl CountingPrompter {
    fn new(sshd: &Sshd) -> Arc<Self> {
        Arc::new(Self {
            password: sshd.password,
            asked_for: StdMutex::default(),
        })
    }

    fn passwords_asked(&self) -> usize {
        self.asked_for().len()
    }

    fn asked_for(&self) -> Vec<String> {
        self.asked_for.lock().unwrap().clone()
    }
}

impl Prompter for CountingPrompter {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, HostKeyDecision> {
        Box::pin(async { HostKeyDecision::SaveAndTrust })
    }

    fn password(&self, prompt: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        self.asked_for.lock().unwrap().push(prompt.host);
        Box::pin(async move {
            // Slow enough that a concurrent connect overlaps this one.
            tokio::time::sleep(Duration::from_millis(200)).await;
            Some(Secret::new(self.password))
        })
    }
}

struct Fixture {
    sshd: Sshd,
    host: Host,
    manager: ConnectionManager,
    sandbox: tempfile::TempDir,
}

impl Fixture {
    fn new(sshd: Sshd) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let host = Host {
            id: HostId::from("counted".to_owned()),
            name: "counted sshd".into(),
            tags: Vec::new(),
            icon: None,
            detected_os: None,
            color: None,
            address: sshd.host.clone(),
            port: sshd.port,
            user: sshd.user.into(),
            auth: HostAuth::Password,
            jump_host: None,
            group_id: None,
            terminal_scheme: None,
            identities_only: false,
            forward_agent: false,
            allow_legacy_algorithms: false,
            open_on_startup: false,
            proxy: Default::default(),
            keepalive_seconds: None,
            post_login_command: None,
            terminal_charset: None,
            terminal_backspace: None,
            default_directory: None,
            forwards: Vec::new(),
            bookmarks: Vec::new(),
        };
        Self {
            manager: ConnectionManager::new(KnownHosts::new(dir.path().join("known_hosts"))),
            sshd,
            host,
            sandbox: dir,
        }
    }

    async fn connect(&self, prompter: &Arc<CountingPrompter>) -> Arc<Connection> {
        self.manager
            .connect(&self.host, prompter.clone())
            .await
            .unwrap()
    }

    /// Waits for the server to see `expected` connections.
    async fn server_sees(&self, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let seen = self.sshd.established_connections();
            if seen == expected {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "the server sees {seen} connections, expected {expected}"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

async fn open_terminal(connection: &Arc<Connection>) -> impl Terminal {
    connection
        .open_shell(TerminalSize { cols: 80, rows: 24 }, |_: TerminalEvent| {})
        .await
        .unwrap()
}

fn draft(host: &Host) -> HostDraft {
    HostDraft {
        name: host.name.clone(),
        tags: Vec::new(),
        icon: None,
        color: None,
        address: host.address.clone(),
        port: host.port,
        user: host.user.clone(),
        auth: host.auth.clone(),
        jump_host: host.jump_host.clone(),
        terminal_scheme: None,
        identities_only: false,
        forward_agent: false,
        allow_legacy_algorithms: false,
        open_on_startup: false,
        proxy: Default::default(),
        keepalive_seconds: None,
        post_login_command: None,
        terminal_charset: None,
        terminal_backspace: None,
        default_directory: None,
    }
}

struct TestLogin {
    password: &'static str,
    entered: Notify,
    proceed: Notify,
}

impl Prompter for TestLogin {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, HostKeyDecision> {
        Box::pin(async { HostKeyDecision::SaveAndTrust })
    }

    fn password(&self, prompt: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        Box::pin(async move {
            assert!(!prompt.can_save);
            self.entered.notify_one();
            self.proceed.notified().await;
            Some(Secret {
                value: self.password.to_owned(),
                save: true,
            })
        })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_draft_test_authenticates_privately_then_closes_without_saving_credentials() {
    let Some(sshd) = support::sshd(Service::Counted) else {
        return;
    };
    let _turn = SERVER.lock().await;
    let mut fx = Fixture::new(sshd);
    let known_hosts = KnownHosts::new(fx.sandbox.path().join("known_hosts"));
    let vault = Arc::new(MemoryVault::default());
    fx.manager = ConnectionManager::new(known_hosts.clone()).with_vault(vault.clone());
    let store = HostStore::open(fx.sandbox.path().join("hosts.json")).unwrap();
    let chain = store.draft_jump_chain(None, draft(&fx.host)).unwrap();
    let target = &chain[0];
    let login = Arc::new(TestLogin {
        password: fx.sshd.password,
        entered: Notify::new(),
        proceed: Notify::new(),
    });
    fx.server_sees(0).await;
    let while_testing = async {
        login.entered.notified().await;
        fx.server_sees(1).await;
        assert!(fx.manager.live(&target.id).await.is_none());
        login.proceed.notify_one();
    };

    let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(
            fx.manager.test_connection(&[], target, login.clone()),
            while_testing
        )
    })
    .await
    .expect("an isolated test never blocks the shared Connection lookup");

    result.unwrap();
    fx.server_sees(0).await;
    assert!(store.list().is_empty());
    assert_eq!(
        vault.get(&target.id, CredentialKind::Password).unwrap(),
        None
    );
    assert!(matches!(
        known_hosts.verify(&target.address, target.port, &fx.sshd.host_key),
        Ok(Verdict::Match)
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_draft_test_checks_authentication_and_address_even_when_the_host_is_connected() {
    let Some(sshd) = support::sshd(Service::Counted) else {
        return;
    };
    let _turn = SERVER.lock().await;
    let fx = Fixture::new(sshd);
    let mut store = HostStore::open(fx.sandbox.path().join("hosts.json")).unwrap();
    let saved = store.upsert(None, draft(&fx.host)).unwrap();
    let live = fx
        .manager
        .connect(&saved, CountingPrompter::new(&fx.sshd))
        .await
        .unwrap();
    fx.server_sees(1).await;

    let wrong_password = Arc::new(CountingPrompter {
        password: "incorrect",
        asked_for: StdMutex::default(),
    });
    let chain = store
        .draft_jump_chain(Some(saved.id.clone()), draft(&saved))
        .unwrap();
    let result = fx
        .manager
        .test_connection(&[], &chain[0], wrong_password)
        .await;
    assert!(
        matches!(result, Err(ConnectError::AuthenticationFailed)),
        "{result:?}"
    );
    fx.server_sees(1).await;

    let mut changed = draft(&saved);
    changed.address = "no-such-host.invalid".into();
    let chain = store
        .draft_jump_chain(Some(saved.id.clone()), changed)
        .unwrap();
    let result = fx
        .manager
        .test_connection(&[], &chain[0], CountingPrompter::new(&fx.sshd))
        .await;
    assert!(
        matches!(result, Err(ConnectError::Unreachable(_))),
        "{result:?}"
    );
    assert_eq!(store.get(&saved.id), Some(&saved));
    assert!(Arc::ptr_eq(
        &live,
        &fx.manager.live(&saved.id).await.unwrap()
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn terminals_on_one_host_share_one_tcp_connection_and_one_login() {
    let Some(sshd) = support::sshd(Service::Counted) else {
        return;
    };
    let _turn = SERVER.lock().await;
    let fx = Fixture::new(sshd);
    fx.server_sees(0).await;
    let prompter = CountingPrompter::new(&fx.sshd);

    let first = open_terminal(&fx.connect(&prompter).await).await;
    let second = open_terminal(&fx.connect(&prompter).await).await;

    fx.server_sees(1).await;
    assert_eq!(prompter.passwords_asked(), 1);
    drop((first, second));
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_the_last_terminal_disconnects_the_connection() {
    let Some(sshd) = support::sshd(Service::Counted) else {
        return;
    };
    let _turn = SERVER.lock().await;
    let fx = Fixture::new(sshd);
    fx.server_sees(0).await;
    let prompter = CountingPrompter::new(&fx.sshd);
    let connection = fx.connect(&prompter).await;
    let mut first = open_terminal(&connection).await;
    let mut second = open_terminal(&connection).await;
    // Only the Terminals hold the Connection now.
    drop(connection);

    first.close().unwrap();
    // Give a wrongly eager disconnect time to happen.
    tokio::time::sleep(Duration::from_millis(500)).await;
    fx.server_sees(1).await;

    second.close().unwrap();
    fx.server_sees(0).await;

    // The next Terminal on the Host connects (and logs in) afresh.
    let _third = open_terminal(&fx.connect(&prompter).await).await;
    fx.server_sees(1).await;
    assert_eq!(prompter.passwords_asked(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_connects_to_one_host_coalesce_into_one_connection() {
    let Some(sshd) = support::sshd(Service::Counted) else {
        return;
    };
    let _turn = SERVER.lock().await;
    let fx = Fixture::new(sshd);
    fx.server_sees(0).await;
    let prompter = CountingPrompter::new(&fx.sshd);

    // As when a Host is opened twice in quick succession.
    let (first, second) = tokio::join!(fx.connect(&prompter), fx.connect(&prompter));

    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(prompter.passwords_asked(), 1);
    fx.server_sees(1).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_panel_browses_over_the_terminals_connection() {
    let Some(sshd) = support::sshd(Service::Counted) else {
        return;
    };
    let _turn = SERVER.lock().await;
    let fx = Fixture::new(sshd);
    fx.server_sees(0).await;
    let prompter = CountingPrompter::new(&fx.sshd);
    assert_eq!(fx.manager.live_count(), 0);
    assert!(fx.manager.live(&fx.host.id).await.is_none());
    let mut terminal = open_terminal(&fx.connect(&prompter).await).await;

    let live = fx.manager.live(&fx.host.id).await;
    let files = live
        .expect("the Terminal's Connection")
        .open_sftp()
        .await
        .unwrap();
    files.home().await.unwrap();

    fx.server_sees(1).await;
    assert_eq!(prompter.passwords_asked(), 1);
    assert_eq!(fx.manager.live_count(), 1);

    // The File panel alone keeps the Connection open...
    terminal.close().unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    fx.server_sees(1).await;
    assert_eq!(fx.manager.live_count(), 1);
    // ...until it closes too.
    drop(files);
    fx.server_sees(0).await;
    assert_eq!(fx.manager.live_count(), 0);
}

/// A Host on the Jump host's private network.
fn behind(name: &str, jump: &Host) -> Host {
    Host {
        id: HostId::from(format!("behind-{name}")),
        name: name.into(),
        tags: Vec::new(),
        icon: None,
        detected_os: None,
        color: None,
        address: name.into(),
        port: 22,
        user: support::USER.into(),
        auth: HostAuth::Password,
        jump_host: Some(jump.id.clone()),
        group_id: None,
        terminal_scheme: None,
        identities_only: false,
        forward_agent: false,
        allow_legacy_algorithms: false,
        open_on_startup: false,
        proxy: Default::default(),
        keepalive_seconds: None,
        post_login_command: None,
        terminal_charset: None,
        terminal_backspace: None,
        default_directory: None,
        forwards: Vec::new(),
        bookmarks: Vec::new(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_draft_test_authenticates_through_its_jump_host_on_fresh_connections() {
    let Some(sshd) = support::sshd(Service::Jump) else {
        return;
    };
    let _turn = SERVER.lock().await;
    let fx = Fixture::new(sshd);
    let mut store = HostStore::open(fx.sandbox.path().join("hosts.json")).unwrap();
    let jump = store.upsert(None, draft(&fx.host)).unwrap();
    let live_jump = fx
        .manager
        .connect(&jump, CountingPrompter::new(&fx.sshd))
        .await
        .unwrap();
    fx.server_sees(1).await;
    let chain = store
        .draft_jump_chain(None, draft(&behind("internal", &jump)))
        .unwrap();
    let (target, hops) = chain.split_last().unwrap();
    let login = CountingPrompter::new(&fx.sshd);

    fx.manager
        .test_connection(hops, target, login.clone())
        .await
        .unwrap();

    assert_eq!(login.asked_for(), [jump.address.as_str(), "internal"]);
    assert!(fx.manager.live(&target.id).await.is_none());
    fx.server_sees(1).await;
    assert!(Arc::ptr_eq(
        &live_jump,
        &fx.manager.live(&jump.id).await.unwrap()
    ));
    assert_eq!(store.list(), &[jump]);
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_connects_through_one_jump_host_share_its_connection() {
    let Some(sshd) = support::sshd(Service::Jump) else {
        return;
    };
    let _turn = SERVER.lock().await;
    let mut fx = Fixture::new(sshd);
    fx.host.id = HostId::from("jump".to_owned());
    fx.server_sees(0).await;
    let prompter = CountingPrompter::new(&fx.sshd);
    let jump = fx.host.clone();
    let (internal, jump2) = (behind("internal", &jump), behind("jump2", &jump));

    // Two Hosts behind the same Jump host, opened at once.
    let hops = std::slice::from_ref(&jump);
    let (a, b) = tokio::join!(
        fx.manager
            .connect_through(hops, &internal, prompter.clone()),
        fx.manager.connect_through(hops, &jump2, prompter.clone()),
    );
    let (_a, _b) = (a.unwrap(), b.unwrap());

    let asked = prompter.asked_for();
    assert_eq!(
        asked.iter().filter(|h| **h == jump.address).count(),
        1,
        "logged in to the Jump host once: {asked:?}"
    );
    assert_eq!(asked.len(), 3, "{asked:?}");
    fx.server_sees(1).await;
}

/// A local Port forward from a free loopback port to the echo server.
fn to_echo(id: &str) -> PortForward {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let (remote_host, remote_port) = support::ECHO;
    PortForward {
        id: ForwardId::from(id.to_owned()),
        label: String::new(),
        auto_start: false,
        kind: ForwardKind::Local {
            bind_address: "127.0.0.1".into(),
            bind_port: port,
            remote_host: remote_host.into(),
            remote_port,
        },
    }
}

/// Whether bytes sent into `rule`'s local port come back from the echo server.
async fn echoes(rule: &PortForward) -> bool {
    let ForwardKind::Local { bind_port, .. } = rule.kind else {
        unreachable!("only local rules here")
    };
    let Ok(mut socket) = tokio::net::TcpStream::connect(("127.0.0.1", bind_port)).await else {
        return false;
    };
    if socket.write_all(b"ping").await.is_err() {
        return false;
    }
    let mut back = [0; 4];
    let read = tokio::time::timeout(Duration::from_secs(10), socket.read_exact(&mut back)).await;
    matches!(read, Ok(Ok(_))) && &back == b"ping"
}

#[tokio::test(flavor = "multi_thread")]
async fn running_port_forwards_keep_the_connection_until_the_last_one_stops() {
    let Some(sshd) = support::sshd(Service::Counted) else {
        return;
    };
    let _turn = SERVER.lock().await;
    let fx = Fixture::new(sshd);
    fx.server_sees(0).await;
    let prompter = CountingPrompter::new(&fx.sshd);
    let forwarder = PortForwarder::new();
    let (first, second) = (to_echo("first"), to_echo("second"));
    let connection = fx.connect(&prompter).await;
    let mut terminal = open_terminal(&connection).await;
    forwarder
        .start(Arc::clone(&connection), &fx.host.id, &first)
        .await
        .unwrap();
    forwarder
        .start(Arc::clone(&connection), &fx.host.id, &second)
        .await
        .unwrap();
    // Only the Terminal and the forwards hold the Connection now.
    drop(connection);

    terminal.close().unwrap();
    // Give a wrongly eager disconnect time to happen.
    tokio::time::sleep(Duration::from_millis(500)).await;
    fx.server_sees(1).await;
    assert!(echoes(&first).await);

    forwarder.stop(&first.id);
    tokio::time::sleep(Duration::from_millis(500)).await;
    fx.server_sees(1).await;
    assert!(echoes(&second).await);

    forwarder.stop(&second.id);
    fx.server_sees(0).await;
    assert_eq!(prompter.passwords_asked(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_held_connection_stays_up_with_nothing_on_it_until_released() {
    let Some(sshd) = support::sshd(Service::Counted) else {
        return;
    };
    let _turn = SERVER.lock().await;
    let fx = Fixture::new(sshd);
    fx.server_sees(0).await;
    let prompter = CountingPrompter::new(&fx.sshd);
    let held = HeldConnections::new();

    held.hold(&fx.host.id, fx.connect(&prompter).await);

    // No Terminal or Port forward holds it, yet it stays up.
    tokio::time::sleep(Duration::from_millis(500)).await;
    fx.server_sees(1).await;
    assert_eq!(held.list(), std::slice::from_ref(&fx.host.id));
    // A Terminal opened afterwards shares it.
    let mut terminal = open_terminal(&fx.connect(&prompter).await).await;
    terminal.close().unwrap();
    assert_eq!(prompter.passwords_asked(), 1);

    held.release(&fx.host.id);
    fx.server_sees(0).await;
    assert!(held.list().is_empty());
}
