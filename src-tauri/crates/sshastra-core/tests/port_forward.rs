//! PortForwarder: local forwards carry real data through a Connection to the
//! echo server in Docker, and report their state.

mod support;

use std::net::TcpListener as StdListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sshastra_core::forward::{
    ForwardError, ForwardEvent, ForwardId, ForwardKind, ForwardStatus, PortForward, PortForwarder,
};
use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{
    BoxFuture, Connection, ConnectionManager, HostKeyPrompt, PasswordPrompt, Prompter,
};
use support::{Service, Sshd};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

struct Trusting(&'static str);

impl Prompter for Trusting {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, bool> {
        Box::pin(async { true })
    }
    fn password(&self, _: PasswordPrompt) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move { Some(self.0.to_owned()) })
    }
}

fn host(sshd: &Sshd) -> Host {
    Host {
        id: HostId::from("forward-target".to_owned()),
        name: "ssh".into(),
        address: sshd.host.clone(),
        port: sshd.port,
        user: sshd.user.into(),
        auth: HostAuth::Password,
        jump_host: None,
        terminal_scheme: None,
        group_id: None,
        forwards: Vec::new(),
    }
}

async fn connect(sshd: &Sshd) -> (Host, Arc<Connection>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let manager = ConnectionManager::new(KnownHosts::new(dir.path().join("known_hosts")));
    let host = host(sshd);
    let connection = manager
        .connect(&host, Arc::new(Trusting(sshd.password)))
        .await
        .unwrap();
    (host, connection, dir)
}

/// A loopback port nothing listens on right now.
fn free_port() -> u16 {
    StdListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn to_echo(id: &str, bind_port: u16) -> PortForward {
    let (remote_host, remote_port) = support::ECHO;
    PortForward {
        id: ForwardId::from(id.to_owned()),
        label: String::new(),
        kind: ForwardKind::Local {
            bind_address: "127.0.0.1".into(),
            bind_port,
            remote_host: remote_host.into(),
            remote_port,
        },
    }
}

/// Sends `message` to the forward's local port and returns what comes back.
async fn round_trip(port: u16, message: &[u8]) -> Vec<u8> {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    socket.write_all(message).await.unwrap();
    let mut back = vec![0; message.len()];
    tokio::time::timeout(Duration::from_secs(10), socket.read_exact(&mut back))
        .await
        .expect("the echo came back in time")
        .unwrap();
    back
}

#[tokio::test(flavor = "multi_thread")]
async fn a_local_forward_carries_data_both_ways() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (host, connection, _dir) = connect(&sshd).await;
    let forwarder = PortForwarder::new();
    let port = free_port();
    let rule = to_echo("echo", port);

    forwarder.start(connection, &host.id, &rule).unwrap();

    assert_eq!(forwarder.status(&rule.id), ForwardStatus::Running);
    assert_eq!(
        round_trip(port, b"hello through ssh").await,
        b"hello through ssh"
    );
    // Several clients at once, each on its own channel.
    let big: Vec<u8> = (0..200_000u32).map(|i| i as u8).collect();
    let (a, b) = tokio::join!(round_trip(port, &big), round_trip(port, b"second"));
    assert_eq!(a, big);
    assert_eq!(b, b"second");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stopped_forward_no_longer_listens() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (host, connection, _dir) = connect(&sshd).await;
    let forwarder = PortForwarder::new();
    let port = free_port();
    let rule = to_echo("stop-me", port);
    forwarder.start(connection, &host.id, &rule).unwrap();

    forwarder.stop(&rule.id);

    assert_eq!(forwarder.status(&rule.id), ForwardStatus::Stopped);
    // The port is free again.
    let mut freed = false;
    for _ in 0..50 {
        if StdListener::bind(("127.0.0.1", port)).is_ok() {
            freed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(freed, "port {port} is still taken after stop");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_port_in_use_fails_with_a_readable_error() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (host, connection, _dir) = connect(&sshd).await;
    let events = Arc::new(Mutex::new(Vec::<ForwardEvent>::new()));
    let seen = events.clone();
    let forwarder = PortForwarder::with_listener(move |e| seen.lock().unwrap().push(e));
    let taken = StdListener::bind("127.0.0.1:0").unwrap();
    let port = taken.local_addr().unwrap().port();
    let rule = to_echo("busy", port);

    let err = forwarder.start(connection, &host.id, &rule).unwrap_err();

    assert!(matches!(err, ForwardError::PortInUse { .. }), "{err:?}");
    assert_eq!(
        err.to_string(),
        format!("port {port} on 127.0.0.1 is already in use")
    );
    let failed = ForwardStatus::Failed {
        reason: err.to_string(),
    };
    assert_eq!(forwarder.status(&rule.id), failed);
    assert_eq!(
        *events.lock().unwrap(),
        [ForwardEvent {
            host_id: host.id.clone(),
            forward_id: rule.id.clone(),
            status: failed,
        }]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn state_changes_are_reported_and_listed() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (host, connection, _dir) = connect(&sshd).await;
    let events = Arc::new(Mutex::new(Vec::<ForwardStatus>::new()));
    let seen = events.clone();
    let forwarder = PortForwarder::with_listener(move |e| seen.lock().unwrap().push(e.status));
    let rule = to_echo("listed", free_port());

    forwarder
        .start(Arc::clone(&connection), &host.id, &rule)
        .unwrap();
    // Starting a running rule again changes nothing.
    forwarder.start(connection, &host.id, &rule).unwrap();
    assert_eq!(
        forwarder.list(),
        [ForwardEvent {
            host_id: host.id.clone(),
            forward_id: rule.id.clone(),
            status: ForwardStatus::Running,
        }]
    );
    forwarder.stop(&rule.id);

    assert!(forwarder.list().is_empty());
    assert_eq!(
        *events.lock().unwrap(),
        [ForwardStatus::Running, ForwardStatus::Stopped]
    );
}
