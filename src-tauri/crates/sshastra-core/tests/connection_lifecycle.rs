//! One Connection per Host, counted from the server's side: Terminals share
//! it, concurrent connects coalesce into it, and it is disconnected once the
//! last Terminal on it closes. Runs against the `counted` sshd in Docker,
//! which nothing else connects to (see `support`), and the `jump` sshd, which
//! no other test connects to while this binary runs.

mod support;

use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{
    BoxFuture, Connection, ConnectionManager, HostKeyPrompt, PasswordPrompt, Prompter,
};
use sshastra_core::terminal::{Terminal, TerminalEvent, TerminalSize};
use support::{Service, Sshd};
use tokio::sync::Mutex;

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
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, bool> {
        Box::pin(async { true })
    }

    fn password(&self, prompt: PasswordPrompt) -> BoxFuture<'_, Option<String>> {
        self.asked_for.lock().unwrap().push(prompt.host);
        Box::pin(async move {
            // Slow enough that a concurrent connect overlaps this one.
            tokio::time::sleep(Duration::from_millis(200)).await;
            Some(self.password.to_owned())
        })
    }
}

struct Fixture {
    sshd: Sshd,
    host: Host,
    manager: ConnectionManager,
    _known_hosts: tempfile::TempDir,
}

impl Fixture {
    fn new(sshd: Sshd) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let host = Host {
            id: HostId::from("counted".to_owned()),
            name: "counted sshd".into(),
            address: sshd.host.clone(),
            port: sshd.port,
            user: sshd.user.into(),
            auth: HostAuth::Password,
            jump_host: None,
            terminal_scheme: None,
        };
        Self {
            manager: ConnectionManager::new(KnownHosts::new(dir.path().join("known_hosts"))),
            sshd,
            host,
            _known_hosts: dir,
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

/// A Host on the Jump host's private network.
fn behind(name: &str, jump: &Host) -> Host {
    Host {
        id: HostId::from(format!("behind-{name}")),
        name: name.into(),
        address: name.into(),
        port: 22,
        user: support::USER.into(),
        auth: HostAuth::Password,
        jump_host: Some(jump.id.clone()),
        terminal_scheme: None,
    }
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
