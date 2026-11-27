//! A remote Terminal survives its Connection dropping: it reports the drop,
//! reconnects in the background (a few times, backing off), and carries on
//! with a new shell. A transfer over a dropped Connection keeps its original.
//! These tests share the `flaky` sshd in Docker and take turns disrupting it.

mod support;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sshastra_core::files::{
    remove_tree, ConflictAnswer, DiskFs, FsError, OpenRemote, RemoteFs, Transfer, TransferQueue,
    TransferState,
};
use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{
    BoxFuture, ConnectError, ConnectionManager, HeldConnections, HostKeyPrompt, PasswordPrompt,
    Prompter, ReconnectPolicy, RemoteTerminal, RemoteTerminalOptions, Secret,
};
use sshastra_core::terminal::{
    ConnectionState, ShellIntegrationEvent, Terminal, TerminalEvent, TerminalSize,
};
use support::{Service, Sshd};
use tokio::sync::{mpsc, Mutex};

static SERVER: Mutex<()> = Mutex::const_new(());

const SIZE: TerminalSize = TerminalSize { cols: 80, rows: 24 };

/// The most any one step may take. Waits end as soon as the event arrives;
/// the bound is generous so a busy Docker host does not fail a test.
const EVENT_WAIT: Duration = Duration::from_secs(60);

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

    fn password(&self, _: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        Box::pin(async { Some(Secret::new(support::PASSWORD)) })
    }
}

struct Fixture {
    sshd: Sshd,
    manager: Arc<ConnectionManager>,
    host: Host,
    /// While set, connecting fails as if the server were unreachable.
    down: Arc<AtomicBool>,
    /// How many times a Terminal has tried to connect.
    connects: Arc<AtomicUsize>,
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
            default_directory: None,
            forwards: Vec::new(),
        };
        Self {
            manager: Arc::new(ConnectionManager::new(KnownHosts::new(
                dir.path().join("known_hosts"),
            ))),
            sshd,
            host,
            down: Arc::default(),
            connects: Arc::default(),
            _known_hosts: dir,
        }
    }

    async fn open(&self) -> (RemoteTerminal, Events) {
        self.open_with(false).await
    }

    async fn open_with(&self, shell_integration: bool) -> (RemoteTerminal, Events) {
        let (manager, host, down) = (self.manager.clone(), self.host.clone(), self.down.clone());
        let connects = self.connects.clone();
        let connect = move || {
            let (manager, host, down) = (manager.clone(), host.clone(), down.clone());
            connects.fetch_add(1, Ordering::SeqCst);
            async move {
                if down.load(Ordering::SeqCst) {
                    return Err(ConnectError::Unreachable("the test took it down".into()));
                }
                manager.connect(&host, Arc::new(TrustingPrompter)).await
            }
        };
        let (tx, rx) = mpsc::unbounded_channel();
        let options = RemoteTerminalOptions {
            reconnect: POLICY,
            shell_integration,
        };
        let terminal = RemoteTerminal::open_with(connect, options, SIZE, move |e| {
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
                TerminalEvent::Output(_)
                | TerminalEvent::Cwd(_)
                | TerminalEvent::ShellIntegration(_) => {}
                TerminalEvent::Connection(state) => return state,
                exit @ TerminalEvent::Exit { .. } => panic!("the Terminal ended: {exit:?}"),
            }
        }
    }

    /// The next directory the shell reports, skipping output.
    async fn cwd(&mut self, within: Duration) -> String {
        loop {
            match self.next(within).await {
                TerminalEvent::Output(_) | TerminalEvent::ShellIntegration(_) => {}
                TerminalEvent::Cwd(path) => return path,
                other => panic!("unexpected {other:?} while waiting for a directory report"),
            }
        }
    }

    async fn marker(&mut self) -> ShellIntegrationEvent {
        let deadline = Instant::now() + EVENT_WAIT;
        loop {
            match self
                .next(deadline.saturating_duration_since(Instant::now()))
                .await
            {
                TerminalEvent::ShellIntegration(ShellIntegrationEvent::Availability { .. })
                | TerminalEvent::Output(_)
                | TerminalEvent::Cwd(_) => {}
                TerminalEvent::ShellIntegration(marker) => return marker,
                other => panic!("unexpected {other:?} while waiting for a shell marker"),
            }
        }
    }

    /// Runs `echo` in the shell and returns the shell's process id.
    async fn shell_pid(&mut self, terminal: &mut RemoteTerminal) -> String {
        terminal.write(b"echo \"pid-$$-end\"\n").unwrap();
        let mut seen = String::new();
        let deadline = Instant::now() + EVENT_WAIT;
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
                TerminalEvent::Cwd(_) | TerminalEvent::ShellIntegration(_) => {}
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
        events.state(EVENT_WAIT).await,
        ConnectionState::Reconnecting {
            attempt: 1,
            attempts: 3
        }
    );
    assert_eq!(events.state(EVENT_WAIT).await, ConnectionState::Connected);
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
            events.state(EVENT_WAIT).await,
            ConnectionState::Reconnecting {
                attempt,
                attempts: 3
            }
        );
    }
    let ConnectionState::Disconnected { reason } = events.state(EVENT_WAIT).await else {
        panic!("expected Disconnected after the last retry");
    };
    assert!(reason.contains("the test took it down"), "{reason}");
    // The first connect and three retries, then it stops trying by itself:
    // the next event (below) is the manual reconnect's first try, not a
    // fourth automatic one.
    assert_eq!(fx.connects.load(Ordering::SeqCst), 4);

    fx.down.store(false, Ordering::SeqCst);
    terminal.reconnect().unwrap();
    assert_eq!(
        events.state(EVENT_WAIT).await,
        ConnectionState::Reconnecting {
            attempt: 1,
            attempts: 1
        }
    );
    assert_eq!(events.state(EVENT_WAIT).await, ConnectionState::Connected);
    assert_eq!(fx.connects.load(Ordering::SeqCst), 5);
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
    let noticed = events.state(EVENT_WAIT).await;
    let waited = frozen.elapsed();
    fx.sshd.unpause();

    assert!(
        matches!(noticed, ConnectionState::Reconnecting { attempt: 1, .. }),
        "{noticed:?}"
    );
    // Three unanswered 1 s keepalives; the 30 s default would take minutes.
    assert!(waited < Duration::from_secs(15), "noticed after {waited:?}");
    assert_eq!(events.state(EVENT_WAIT).await, ConnectionState::Connected);
    events.shell_pid(&mut terminal).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn shell_integration_goes_into_the_new_shell_after_a_reconnect() {
    let Some(sshd) = support::sshd(Service::Flaky) else {
        return;
    };
    let _turn = SERVER.lock().await;
    let fx = Fixture::new(sshd);
    let (mut terminal, mut events) = fx.open_with(true).await;
    assert_eq!(events.cwd(EVENT_WAIT).await, "/home/tester");
    terminal.write(b"cd /srv/files\r").unwrap();
    assert_eq!(events.cwd(EVENT_WAIT).await, "/srv/files");

    fx.sshd.drop_connections();
    assert!(matches!(
        events.state(EVENT_WAIT).await,
        ConnectionState::Reconnecting { .. }
    ));
    assert_eq!(events.state(EVENT_WAIT).await, ConnectionState::Connected);

    // The new shell starts at home and resumes directory and command reports.
    assert_eq!(events.cwd(EVENT_WAIT).await, "/home/tester");
    assert_eq!(events.marker().await, ShellIntegrationEvent::PromptStart);
    let line = "cd /srv/files/docs";
    terminal.write(format!("{line}\r").as_bytes()).unwrap();
    assert_eq!(
        events.marker().await,
        ShellIntegrationEvent::CommandStart {
            command_line: Some(line.into())
        }
    );
    assert_eq!(
        events.marker().await,
        ShellIntegrationEvent::CommandEnd { exit_code: 0 }
    );
    assert_eq!(events.cwd(EVENT_WAIT).await, "/srv/files/docs");
    assert_eq!(events.marker().await, ShellIntegrationEvent::PromptStart);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_held_connection_that_drops_is_reported_and_let_go() {
    let Some(sshd) = support::sshd(Service::Flaky) else {
        return;
    };
    let _turn = SERVER.lock().await;
    let fx = Fixture::new(sshd);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let held = HeldConnections::with_listener(move |event| {
        let _ = tx.send(event);
    });
    let connection = fx
        .manager
        .connect(&fx.host, Arc::new(TrustingPrompter))
        .await
        .unwrap();
    held.hold(&fx.host.id, connection);
    let first = tokio::time::timeout(EVENT_WAIT, rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(first.held);

    fx.sshd.drop_connections();

    let event = tokio::time::timeout(EVENT_WAIT, rx.recv())
        .await
        .expect("the drop is reported in time")
        .unwrap();
    assert_eq!(event.host_id, fx.host.id);
    assert!(!event.held);
    assert!(held.list().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn dropping_the_connection_during_upload_keeps_the_remote_original() {
    let Some(sshd) = support::sshd(Service::Flaky) else {
        return;
    };
    let _turn = SERVER.lock().await;
    let f = Fixture::new(sshd);
    let dir = f
        .sshd
        .run_as_tester("mktemp -d /home/tester/transfer.XXXXXXXX");
    let dir = dir.trim();
    let file = format!("{dir}/report.bin");
    f.sshd.run_as_tester(&format!(
        "printf 'original' > '{file}' && chmod 0750 '{file}'"
    ));
    let local = f._known_hosts.path().join("report.bin");
    let bytes = vec![17; 5 * 1024 * 1024];
    std::fs::write(&local, &bytes).unwrap();

    let (manager, host) = (f.manager.clone(), f.host.clone());
    let open: OpenRemote = Arc::new(move || {
        let (manager, host) = (manager.clone(), host.clone());
        Box::pin(async move {
            let connection = manager
                .connect(&host, Arc::new(TrustingPrompter))
                .await
                .map_err(|e| FsError::Protocol(e.to_string()))?;
            let fs: Arc<dyn RemoteFs> = Arc::new(connection.open_sftp().await?);
            Ok(fs)
        })
    });

    let dropped = Arc::new(AtomicBool::new(false));
    let disconnected = dropped.clone();
    let sshd = f.sshd.clone();
    let (tx, mut events) = mpsc::unbounded_channel();
    let queue = TransferQueue::new(Arc::new(DiskFs), move |t| {
        if t.state == TransferState::Running
            && t.bytes_done > 0
            && t.bytes_done < t.bytes_total
            && !disconnected.swap(true, Ordering::SeqCst)
        {
            sshd.drop_connections();
        }
        let _ = tx.send(t.clone());
    });

    async fn wait_for(
        events: &mut mpsc::UnboundedReceiver<Transfer>,
        predicate: impl Fn(&TransferState) -> bool,
    ) -> Transfer {
        tokio::time::timeout(EVENT_WAIT, async {
            loop {
                let transfer = events.recv().await.unwrap();
                if predicate(&transfer.state) {
                    return transfer;
                }
            }
        })
        .await
        .expect("expected transfer state")
    }

    let transfer = queue.upload(open.clone(), local, dir.to_owned());
    wait_for(&mut events, |state| {
        matches!(state, TransferState::Conflict { .. })
    })
    .await;
    queue.answer(transfer, ConflictAnswer::Overwrite);
    let failed = wait_for(&mut events, |state| {
        matches!(state, TransferState::Failed { .. } | TransferState::Done)
    })
    .await;
    assert!(
        matches!(failed.state, TransferState::Failed { .. }),
        "{failed:?}"
    );
    assert!(dropped.load(Ordering::SeqCst));
    // Check directly in the container, independently of reconnect and cleanup.
    assert_eq!(f.sshd.run_as_tester(&format!("cat '{file}'")), "original");

    queue.retry(transfer);
    wait_for(&mut events, |state| {
        matches!(state, TransferState::Conflict { .. })
    })
    .await;
    queue.answer(transfer, ConflictAnswer::Overwrite);
    let retried = wait_for(&mut events, |state| {
        matches!(state, TransferState::Failed { .. } | TransferState::Done)
    })
    .await;
    assert_eq!(retried.state, TransferState::Done);

    let fs = open().await.unwrap();
    assert_eq!(fs.read_file(&file).await.unwrap(), bytes);
    assert_eq!(fs.stat(&file).await.unwrap().permissions, Some(0o750));
    let entries = fs.list_dir(dir).await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "report.bin");
    remove_tree(&*fs, dir).await.unwrap();
}
