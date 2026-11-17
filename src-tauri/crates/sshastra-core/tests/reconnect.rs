//! A remote Terminal survives its Connection dropping: it reports the drop,
//! reconnects in the background (a few times, backing off), and carries on
//! with a new shell. Runs against the `flaky` sshd in Docker, which only these
//! tests use; they kill and freeze it, so they take turns.

mod support;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{
    BoxFuture, ConnectError, ConnectionManager, HostKeyPrompt, PasswordPrompt, Prompter,
    ReconnectPolicy, RemoteTerminal,
};
use sshastra_core::terminal::{ConnectionState, Terminal, TerminalEvent, TerminalSize};
use support::{Service, Sshd};
use tokio::sync::{mpsc, Mutex};

static SERVER: Mutex<()> = Mutex::const_new(());

const SIZE: TerminalSize = TerminalSize { cols: 80, rows: 24 };

/// Quick retries, so a test that waits for all of them stays short.
const POLICY: ReconnectPolicy = ReconnectPolicy {
    attempts: 3,
    first_delay: Duration::from_millis(300),
};

struct TrustingPrompter;

impl Prompter for TrustingPrompter {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, bool> {
        Box::pin(async { true })
    }

    fn password(&self, _: PasswordPrompt) -> BoxFuture<'_, Option<String>> {
        Box::pin(async { Some(support::PASSWORD.to_owned()) })
    }
}

struct Fixture {
    sshd: Sshd,
    manager: Arc<ConnectionManager>,
    host: Host,
    /// While set, connecting fails as if the server were unreachable.
    down: Arc<AtomicBool>,
    _known_hosts: tempfile::TempDir,
}

impl Fixture {
    fn new(sshd: Sshd) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let host = Host {
            id: HostId::from("flaky".to_owned()),
            name: "flaky sshd".into(),
            address: sshd.host.clone(),
            port: sshd.port,
            user: sshd.user.into(),
            auth: HostAuth::Password,
            jump_host: None,
            group_id: None,
            terminal_scheme: None,
        };
        Self {
            manager: Arc::new(ConnectionManager::new(KnownHosts::new(
                dir.path().join("known_hosts"),
            ))),
            sshd,
            host,
            down: Arc::default(),
            _known_hosts: dir,
        }
    }

    async fn open(&self) -> (RemoteTerminal, Events) {
        let (manager, host, down) = (self.manager.clone(), self.host.clone(), self.down.clone());
        let connect = move || {
            let (manager, host, down) = (manager.clone(), host.clone(), down.clone());
            async move {
                if down.load(Ordering::SeqCst) {
                    return Err(ConnectError::Unreachable("the test took it down".into()));
                }
                manager.connect(&host, Arc::new(TrustingPrompter)).await
            }
        };
        let (tx, rx) = mpsc::unbounded_channel();
        let terminal = RemoteTerminal::open(connect, POLICY, SIZE, move |e| {
            let _ = tx.send(e);
        })
        .await
        .unwrap();
        (terminal, Events { rx })
    }
}

struct Events {
    rx: mpsc::UnboundedReceiver<TerminalEvent>,
}

impl Events {
    async fn next(&mut self, within: Duration) -> TerminalEvent {
        tokio::time::timeout(within, self.rx.recv())
            .await
            .expect("no Terminal event in time")
            .expect("the Terminal's events ended")
    }

    /// The next Connection state, skipping output; fails on `Exit`.
    async fn state(&mut self, within: Duration) -> ConnectionState {
        loop {
            match self.next(within).await {
                TerminalEvent::Output(_) => {}
                TerminalEvent::Connection(state) => return state,
                exit @ TerminalEvent::Exit { .. } => panic!("the Terminal ended: {exit:?}"),
            }
        }
    }

    /// Runs `echo` in the shell and returns the shell's process id.
    async fn shell_pid(&mut self, terminal: &mut RemoteTerminal) -> String {
        terminal.write(b"echo \"pid-$$-end\"\n").unwrap();
        let mut seen = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            // The typed command echoes back as `pid-$$-end`; the answer has digits.
            if let Some(pid) = seen
                .split("pid-")
                .filter_map(|s| s.split_once("-end").map(|(pid, _)| pid))
                .find(|pid| !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()))
            {
                return pid.to_owned();
            }
            match self.next(deadline - Instant::now()).await {
                TerminalEvent::Output(bytes) => seen.push_str(&String::from_utf8_lossy(&bytes)),
                other => panic!("unexpected {other:?} while waiting for the shell; saw {seen:?}"),
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dropped_connection_reconnects_and_the_terminal_gets_a_new_shell() {
    let Some(sshd) = support::sshd(Service::Flaky) else {
        return;
    };
    let _turn = SERVER.lock().await;
    let fx = Fixture::new(sshd);
    let (mut terminal, mut events) = fx.open().await;
    let before = events.shell_pid(&mut terminal).await;

    fx.sshd.drop_connections();

    assert_eq!(
        events.state(Duration::from_secs(10)).await,
        ConnectionState::Reconnecting {
            attempt: 1,
            attempts: 3
        }
    );
    assert_eq!(
        events.state(Duration::from_secs(10)).await,
        ConnectionState::Connected
    );
    let after = events.shell_pid(&mut terminal).await;
    assert_ne!(before, after, "the Terminal runs a new shell");
}

#[tokio::test(flavor = "multi_thread")]
async fn after_the_retries_fail_only_a_manual_reconnect_brings_it_back() {
    let Some(sshd) = support::sshd(Service::Flaky) else {
        return;
    };
    let _turn = SERVER.lock().await;
    let fx = Fixture::new(sshd);
    let (mut terminal, mut events) = fx.open().await;
    events.shell_pid(&mut terminal).await;

    fx.down.store(true, Ordering::SeqCst);
    fx.sshd.drop_connections();

    for attempt in 1..=3 {
        assert_eq!(
            events.state(Duration::from_secs(10)).await,
            ConnectionState::Reconnecting {
                attempt,
                attempts: 3
            }
        );
    }
    let ConnectionState::Disconnected { reason } = events.state(Duration::from_secs(10)).await
    else {
        panic!("expected Disconnected after the last retry");
    };
    assert!(reason.contains("the test took it down"), "{reason}");
    // It stays disconnected: no more automatic tries.
    assert!(
        tokio::time::timeout(Duration::from_secs(3), events.rx.recv())
            .await
            .is_err(),
        "nothing happens until the user asks"
    );

    fx.down.store(false, Ordering::SeqCst);
    terminal.reconnect().unwrap();
    assert_eq!(
        events.state(Duration::from_secs(10)).await,
        ConnectionState::Reconnecting {
            attempt: 1,
            attempts: 1
        }
    );
    assert_eq!(
        events.state(Duration::from_secs(10)).await,
        ConnectionState::Connected
    );
    events.shell_pid(&mut terminal).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn keepalives_at_the_configured_interval_notice_a_silent_server() {
    let Some(sshd) = support::sshd(Service::Flaky) else {
        return;
    };
    let _turn = SERVER.lock().await;
    let fx = Fixture::new(sshd);
    fx.manager
        .set_keepalive_interval(Some(Duration::from_secs(1)));
    let (mut terminal, mut events) = fx.open().await;
    events.shell_pid(&mut terminal).await;

    // Nothing is closed; the server just stops answering.
    let frozen = Instant::now();
    fx.sshd.pause();
    let noticed = events.state(Duration::from_secs(20)).await;
    let waited = frozen.elapsed();
    fx.sshd.unpause();

    assert!(
        matches!(noticed, ConnectionState::Reconnecting { attempt: 1, .. }),
        "{noticed:?}"
    );
    // Three unanswered 1 s keepalives; the 30 s default would take minutes.
    assert!(waited < Duration::from_secs(15), "noticed after {waited:?}");
    assert_eq!(
        events.state(Duration::from_secs(20)).await,
        ConnectionState::Connected
    );
    events.shell_pid(&mut terminal).await;
}
