//! PortForwarder: each kind carries real data through a Connection (to the
//! echo server in Docker, or to one on this machine) and reports its state.

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
    BoxFuture, Connection, ConnectionManager, HostKeyDecision, HostKeyPrompt, PasswordPrompt,
    Prompter, Secret,
};
use support::{Service, Sshd};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

// Dropping a Connection on `flaky` also drops any others using that service.
static FLAKY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Trusting(&'static str);

impl Prompter for Trusting {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, HostKeyDecision> {
        Box::pin(async { HostKeyDecision::SaveAndTrust })
    }
    fn password(&self, _: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        Box::pin(async move { Some(Secret::new(self.0)) })
    }
}

fn host(sshd: &Sshd) -> Host {
    Host {
        id: HostId::from("forward-target".to_owned()),
        name: "ssh".into(),
        tags: Vec::new(),
        icon: None,
        detected_os: None,
        color: None,
        address: sshd.host.clone(),
        port: sshd.port,
        user: sshd.user.into(),
        auth: HostAuth::Password,
        jump_host: None,
        terminal_scheme: None,
        identities_only: false,
        forward_agent: false,
        allow_legacy_algorithms: false,
        open_on_startup: false,
        agent_access: Default::default(),
        proxy: Default::default(),
        keepalive_seconds: None,
        post_login_command: None,
        terminal_charset: None,
        terminal_backspace: None,
        default_directory: None,
        group_id: None,
        forwards: Vec::new(),
        bookmarks: Vec::new(),
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
        auto_start: false,
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

    forwarder.start(connection, &host.id, &rule).await.unwrap();

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
    forwarder.start(connection, &host.id, &rule).await.unwrap();

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

    let err = forwarder
        .start(connection, &host.id, &rule)
        .await
        .unwrap_err();

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
        .await
        .unwrap();
    // Starting a running rule again changes nothing.
    forwarder.start(connection, &host.id, &rule).await.unwrap();
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

/// A TCP echo server on this machine; returns its port.
async fn local_echo() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut read, mut write) = socket.split();
                let _ = tokio::io::copy(&mut read, &mut write).await;
            });
        }
    });
    port
}

fn remote(id: &str, bind_port: u16, local_port: u16) -> PortForward {
    PortForward {
        id: ForwardId::from(id.to_owned()),
        label: String::new(),
        auto_start: false,
        kind: ForwardKind::Remote {
            bind_address: "127.0.0.1".into(),
            bind_port,
            local_host: "127.0.0.1".into(),
            local_port,
        },
    }
}

/// A local forward to `127.0.0.1:port` as the server sees it, so the test can
/// reach a port the server listens on; returns the local port.
async fn reach_server_port(
    forwarder: &PortForwarder,
    host: &Host,
    connection: &Arc<Connection>,
    port: u16,
) -> u16 {
    let local = free_port();
    let rule = PortForward {
        id: ForwardId::from(format!("reach-{port}")),
        label: String::new(),
        auto_start: false,
        kind: ForwardKind::Local {
            bind_address: "127.0.0.1".into(),
            bind_port: local,
            remote_host: "127.0.0.1".into(),
            remote_port: port,
        },
    };
    forwarder
        .start(Arc::clone(connection), &host.id, &rule)
        .await
        .unwrap();
    local
}

// Each remote forward test listens on its own port on the shared `ssh` server.

#[tokio::test(flavor = "multi_thread")]
async fn a_remote_forward_carries_data_from_the_server_to_this_machine() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (host, connection, _dir) = connect(&sshd).await;
    let forwarder = PortForwarder::new();
    let target = local_echo().await;
    let rule = remote("remote-echo", 17001, target);

    forwarder
        .start(Arc::clone(&connection), &host.id, &rule)
        .await
        .unwrap();

    assert_eq!(forwarder.status(&rule.id), ForwardStatus::Running);
    let entry = reach_server_port(&forwarder, &host, &connection, 17001).await;
    assert_eq!(
        round_trip(entry, b"from the server").await,
        b"from the server"
    );
    let big: Vec<u8> = (0..200_000u32).map(|i| (i * 7) as u8).collect();
    let (a, b) = tokio::join!(round_trip(entry, &big), round_trip(entry, b"second"));
    assert_eq!(a, big);
    assert_eq!(b, b"second");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stopped_remote_forward_frees_the_server_port_for_a_restart() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (host, connection, _dir) = connect(&sshd).await;
    let forwarder = PortForwarder::new();
    let target = local_echo().await;
    let rule = remote("remote-restart", 17002, target);
    forwarder
        .start(Arc::clone(&connection), &host.id, &rule)
        .await
        .unwrap();

    forwarder.stop(&rule.id);

    // The server is told to stop listening, so the rule starts again.
    let mut restarted = Err(None);
    for _ in 0..50 {
        match forwarder
            .start(Arc::clone(&connection), &host.id, &rule)
            .await
        {
            Ok(()) => {
                restarted = Ok(());
                break;
            }
            Err(e) => restarted = Err(Some(e)),
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    restarted.unwrap_or_else(|e| panic!("could not restart: {e:?}"));
    let entry = reach_server_port(&forwarder, &host, &connection, 17002).await;
    assert_eq!(round_trip(entry, b"again").await, b"again");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_remote_port_the_server_refuses_fails_with_a_readable_error() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (host, connection, _dir) = connect(&sshd).await;
    let forwarder = PortForwarder::new();
    let target = local_echo().await;
    let first = remote("remote-first", 17003, target);
    let second = remote("remote-second", 17003, target);
    forwarder
        .start(Arc::clone(&connection), &host.id, &first)
        .await
        .unwrap();

    let err = forwarder
        .start(connection, &host.id, &second)
        .await
        .unwrap_err();

    assert!(matches!(err, ForwardError::RemoteRefused { .. }), "{err:?}");
    assert_eq!(
        err.to_string(),
        "the server refused to listen on port 17003 on 127.0.0.1"
    );
    assert_eq!(
        forwarder.status(&second.id),
        ForwardStatus::Failed {
            reason: err.to_string()
        }
    );
    assert_eq!(forwarder.status(&first.id), ForwardStatus::Running);
}

fn dynamic(id: &str, bind_port: u16) -> PortForward {
    PortForward {
        id: ForwardId::from(id.to_owned()),
        label: String::new(),
        auto_start: false,
        kind: ForwardKind::Dynamic {
            bind_address: "127.0.0.1".into(),
            bind_port,
        },
    }
}

fn http(bind_port: u16) -> PortForward {
    PortForward {
        id: ForwardId::from("http".to_owned()),
        label: String::new(),
        auto_start: false,
        kind: ForwardKind::Http {
            bind_address: "127.0.0.1".into(),
            bind_port,
        },
    }
}

async fn http_reply(socket: &mut BufReader<TcpStream>) -> String {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut head = String::new();
        loop {
            let mut line = String::new();
            assert_ne!(socket.read_line(&mut line).await.unwrap(), 0);
            head.push_str(&line);
            if line == "\r\n" {
                return head;
            }
        }
    })
    .await
    .expect("the proxy replied in time")
}

#[tokio::test(flavor = "multi_thread")]
async fn an_http_forward_connects_to_the_echo_service_and_preserves_tunnel_bytes() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (host, connection, _dir) = connect(&sshd).await;
    let forwarder = PortForwarder::new();
    let port = free_port();
    let rule = http(port);
    forwarder.start(connection, &host.id, &rule).await.unwrap();
    assert_eq!(forwarder.status(&rule.id), ForwardStatus::Running);

    let (echo_host, echo_port) = support::ECHO;
    let mut socket = BufReader::new(TcpStream::connect(("127.0.0.1", port)).await.unwrap());
    let mut request = format!(
        "CONNECT {echo_host}:{echo_port} HTTP/1.1\r\nHost: {echo_host}:{echo_port}\r\n\r\n"
    )
    .into_bytes();
    let first = b"\x00\xffearly data\r\n";
    request.extend_from_slice(first);
    socket.write_all(&request).await.unwrap();
    assert!(http_reply(&mut socket).await.starts_with("HTTP/1.1 200 "));
    let second = b"more data";
    socket.write_all(second).await.unwrap();
    let mut back = vec![0; first.len() + second.len()];
    tokio::time::timeout(Duration::from_secs(10), socket.read_exact(&mut back))
        .await
        .expect("the echo came back in time")
        .unwrap();
    assert_eq!(back, [first.as_slice(), second.as_slice()].concat());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_http_forward_rejects_other_methods_and_invalid_connect_requests() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (host, connection, _dir) = connect(&sshd).await;
    let forwarder = PortForwarder::new();
    let port = free_port();
    let rule = http(port);
    forwarder.start(connection, &host.id, &rule).await.unwrap();

    let (echo_host, echo_port) = support::ECHO;
    let get = format!(
        "GET http://{echo_host}:{echo_port}/ HTTP/1.1\r\nHost: {echo_host}:{echo_port}\r\n\r\n"
    );
    let body = format!("CONNECT {echo_host}:{echo_port} HTTP/1.1\r\nContent-Length: 1\r\n\r\nx");
    let oversized = format!(
        "CONNECT {echo_host}:{echo_port} HTTP/1.1\r\nX-Long: {}\r\n\r\n",
        "x".repeat(16_384)
    );
    for (request, code) in [(get, "405"), (body, "400"), (oversized, "431")] {
        let mut socket = BufReader::new(TcpStream::connect(("127.0.0.1", port)).await.unwrap());
        socket.write_all(request.as_bytes()).await.unwrap();
        let reply = http_reply(&mut socket).await;
        assert!(reply.starts_with(&format!("HTTP/1.1 {code} ")), "{reply}");
        if code == "405" {
            assert!(reply.contains("\r\nAllow: CONNECT\r\n"));
        }
    }

    for target in [
        "echo",
        "echo:0",
        "echo:65536",
        "echo:+7777",
        "echo:7777/path",
        "http://echo:7777",
        "user@echo:7777",
        "echo:7777?extra",
        "[echo]:7777",
        "::1:7777",
    ] {
        let mut socket = BufReader::new(TcpStream::connect(("127.0.0.1", port)).await.unwrap());
        let request = format!("CONNECT {target} HTTP/1.1\r\nHost: {echo_host}:{echo_port}\r\n\r\n");
        socket.write_all(request.as_bytes()).await.unwrap();
        let reply = http_reply(&mut socket).await;
        assert!(reply.starts_with("HTTP/1.1 400 "), "{target}: {reply}");
    }

    let mut socket = BufReader::new(TcpStream::connect(("127.0.0.1", port)).await.unwrap());
    socket
        .write_all(b"CONNECT 127.0.0.1:1 HTTP/1.0\r\n\r\n")
        .await
        .unwrap();
    assert!(http_reply(&mut socket).await.starts_with("HTTP/1.1 502 "));
    assert_eq!(forwarder.status(&rule.id), ForwardStatus::Running);
}

/// Where a SOCKS5 CONNECT goes, as the client names it.
enum Destination<'a> {
    Name(&'a str),
    V4([u8; 4]),
}

/// Opens a SOCKS5 CONNECT through the proxy on `proxy` and returns the reply
/// code (0 = succeeded) and, when it succeeded, the stream to `destination`.
async fn socks5_connect(
    proxy: u16,
    destination: Destination<'_>,
    port: u16,
) -> (u8, Option<TcpStream>) {
    let mut socket = TcpStream::connect(("127.0.0.1", proxy)).await.unwrap();
    // Greeting: version 5, one method, "no authentication".
    socket.write_all(&[5, 1, 0]).await.unwrap();
    let mut choice = [0; 2];
    socket.read_exact(&mut choice).await.unwrap();
    assert_eq!(choice, [5, 0], "the proxy accepts no authentication");
    let mut request = vec![5, 1, 0];
    match destination {
        Destination::Name(name) => {
            request.push(3);
            request.push(name.len() as u8);
            request.extend_from_slice(name.as_bytes());
        }
        Destination::V4(ip) => {
            request.push(1);
            request.extend_from_slice(&ip);
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    socket.write_all(&request).await.unwrap();
    // Reply: version, code, reserved, then a bound address we skip.
    let mut head = [0; 4];
    tokio::time::timeout(Duration::from_secs(10), socket.read_exact(&mut head))
        .await
        .expect("the proxy replied in time")
        .unwrap();
    assert_eq!(head[0], 5);
    let rest = match head[3] {
        1 => 4 + 2,
        4 => 16 + 2,
        3 => {
            let mut len = [0; 1];
            socket.read_exact(&mut len).await.unwrap();
            usize::from(len[0]) + 2
        }
        other => panic!("bad address type {other}"),
    };
    let mut skip = vec![0; rest];
    socket.read_exact(&mut skip).await.unwrap();
    (head[1], (head[1] == 0).then_some(socket))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dynamic_forward_is_a_socks5_proxy_through_the_server() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (host, connection, _dir) = connect(&sshd).await;
    let forwarder = PortForwarder::new();
    let proxy = free_port();
    let rule = dynamic("socks", proxy);

    forwarder.start(connection, &host.id, &rule).await.unwrap();
    assert_eq!(forwarder.status(&rule.id), ForwardStatus::Running);

    // By name, resolved by the server: the echo server only it can reach.
    let (echo_host, echo_port) = support::ECHO;
    let (code, socket) = socks5_connect(proxy, Destination::Name(echo_host), echo_port).await;
    assert_eq!(code, 0);
    let mut socket = socket.unwrap();
    let big: Vec<u8> = (0..200_000u32).map(|i| (i * 3) as u8).collect();
    socket.write_all(&big).await.unwrap();
    let mut back = vec![0; big.len()];
    tokio::time::timeout(Duration::from_secs(10), socket.read_exact(&mut back))
        .await
        .expect("the echo came back in time")
        .unwrap();
    assert_eq!(back, big);

    // By IPv4 address: the server's own sshd greets us.
    let (code, socket) = socks5_connect(proxy, Destination::V4([127, 0, 0, 1]), 22).await;
    assert_eq!(code, 0);
    let mut banner = [0; 8];
    socket.unwrap().read_exact(&mut banner).await.unwrap();
    assert_eq!(&banner, b"SSH-2.0-");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_socks5_destination_the_server_cannot_reach_gets_a_failure_reply() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (host, connection, _dir) = connect(&sshd).await;
    let forwarder = PortForwarder::new();
    let proxy = free_port();
    forwarder
        .start(connection, &host.id, &dynamic("socks-fail", proxy))
        .await
        .unwrap();

    // Nothing listens on port 1 on the server.
    let (code, socket) = socks5_connect(proxy, Destination::V4([127, 0, 0, 1]), 1).await;

    assert_ne!(code, 0);
    assert!(socket.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_socks_client_without_a_usable_method_is_turned_away() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (host, connection, _dir) = connect(&sshd).await;
    let forwarder = PortForwarder::new();
    let proxy = free_port();
    forwarder
        .start(connection, &host.id, &dynamic("socks-auth", proxy))
        .await
        .unwrap();
    let mut socket = TcpStream::connect(("127.0.0.1", proxy)).await.unwrap();

    // Offers username/password only.
    socket.write_all(&[5, 1, 2]).await.unwrap();

    let mut choice = [0; 2];
    socket.read_exact(&mut choice).await.unwrap();
    assert_eq!(choice, [5, 0xff]);
}

#[tokio::test(flavor = "multi_thread")]
async fn rules_marked_auto_start_start_on_connect_and_the_others_do_not() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (mut host, connection, _dir) = connect(&sshd).await;
    let forwarder = PortForwarder::new();
    let (auto_port, manual_port) = (free_port(), free_port());
    let taken = StdListener::bind("127.0.0.1:0").unwrap();
    let busy_port = taken.local_addr().unwrap().port();
    host.forwards = vec![
        PortForward {
            auto_start: true,
            ..to_echo("auto", auto_port)
        },
        to_echo("manual", manual_port),
        PortForward {
            auto_start: true,
            ..to_echo("auto-busy", busy_port)
        },
    ];

    let failures = forwarder.start_auto(Arc::clone(&connection), &host).await;

    assert_eq!(
        forwarder.status(&host.forwards[0].id),
        ForwardStatus::Running
    );
    assert_eq!(
        forwarder.status(&host.forwards[1].id),
        ForwardStatus::Stopped
    );
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].0, host.forwards[2].id);
    assert!(matches!(failures[0].1, ForwardError::PortInUse { .. }));
    assert_eq!(round_trip(auto_port, b"auto").await, b"auto");
    // Connecting again leaves running rules as they are.
    assert_eq!(forwarder.start_auto(connection, &host).await.len(), 1);
    assert_eq!(round_trip(auto_port, b"still").await, b"still");
}

struct FlakyConnection {
    sshd: Sshd,
    host: Host,
    manager: ConnectionManager,
    _known_hosts: tempfile::TempDir,
}

impl FlakyConnection {
    fn new(sshd: Sshd) -> Self {
        let host = host(&sshd);
        let dir = tempfile::tempdir().unwrap();
        let manager = ConnectionManager::new(KnownHosts::new(dir.path().join("known_hosts")));
        Self {
            sshd,
            host,
            manager,
            _known_hosts: dir,
        }
    }

    async fn connect(&self) -> Arc<Connection> {
        self.manager
            .connect(&self.host, Arc::new(Trusting(self.sshd.password)))
            .await
            .unwrap()
    }

    async fn drop_transport(&self) {
        self.sshd.drop_connections();
        tokio::time::timeout(Duration::from_secs(10), async {
            while self.manager.live(&self.host.id).await.is_some() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the SSH Connection closes");
    }
}

fn lost() -> ForwardStatus {
    ForwardStatus::Failed {
        reason: "the Connection was lost".into(),
    }
}

async fn wait_for_forward_loss(forwarder: &PortForwarder, rule: &PortForward) {
    let lost = lost();
    tokio::time::timeout(Duration::from_secs(10), async {
        while forwarder.status(&rule.id) != lost {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the Port forward reports losing its Connection");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_manually_started_forward_recovers_on_the_hosts_next_connection() {
    let Some(sshd) = support::sshd(Service::Flaky) else {
        return;
    };
    let _turn = FLAKY.lock().await;
    let mut fixture = FlakyConnection::new(sshd);
    let port = free_port();
    let rule = to_echo("recover-manual", port);
    fixture.host.forwards.push(rule.clone());
    let connection = fixture.connect().await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&events);
    let forwarder = PortForwarder::with_listener(move |event| {
        seen.lock().unwrap().push(event.status);
    });
    forwarder
        .start(Arc::clone(&connection), &fixture.host.id, &rule)
        .await
        .unwrap();
    assert_eq!(round_trip(port, b"before").await, b"before");

    fixture.drop_transport().await;

    // Do not wait for the forward's own loss check before reconnecting.
    let replacement = fixture.connect().await;
    // A late caller can also report the old pooled Connection.
    let (stale, first, second) = tokio::join!(
        forwarder.start_auto(connection, &fixture.host),
        forwarder.start_auto(Arc::clone(&replacement), &fixture.host),
        forwarder.start_auto(replacement, &fixture.host),
    );

    assert!(stale.is_empty() && first.is_empty() && second.is_empty());
    assert_eq!(forwarder.status(&rule.id), ForwardStatus::Running);
    assert_eq!(
        *events.lock().unwrap(),
        [ForwardStatus::Running, lost(), ForwardStatus::Running]
    );
    assert_eq!(round_trip(port, b"after").await, b"after");
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_connect_callbacks_restore_one_remote_listener() {
    let Some(sshd) = support::sshd(Service::Flaky) else {
        return;
    };
    let _turn = FLAKY.lock().await;
    let mut fixture = FlakyConnection::new(sshd);
    let rule = PortForward {
        auto_start: true,
        ..remote("restore-remote", 17004, local_echo().await)
    };
    fixture.host.forwards.push(rule.clone());
    let connection = fixture.connect().await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&events);
    let forwarder = PortForwarder::with_listener(move |event| seen.lock().unwrap().push(event));
    assert!(forwarder
        .start_auto(Arc::clone(&connection), &fixture.host)
        .await
        .is_empty());
    let entry = reach_server_port(&forwarder, &fixture.host, &connection, 17004).await;
    assert_eq!(
        round_trip(entry, b"before remote reconnect").await,
        b"before remote reconnect"
    );

    fixture.drop_transport().await;
    let replacement = fixture.connect().await;
    let (first, second) = tokio::join!(
        forwarder.start_auto(Arc::clone(&replacement), &fixture.host),
        forwarder.start_auto(Arc::clone(&replacement), &fixture.host),
    );

    assert!(first.is_empty() && second.is_empty());
    let entry = reach_server_port(&forwarder, &fixture.host, &replacement, 17004).await;
    assert_eq!(
        round_trip(entry, b"after remote reconnect").await,
        b"after remote reconnect"
    );
    let reported: Vec<_> = events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event.forward_id == rule.id)
        .map(|event| event.status.clone())
        .collect();
    assert_eq!(
        reported,
        [ForwardStatus::Running, lost(), ForwardStatus::Running]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_and_deletion_win_over_pending_restores() {
    let Some(sshd) = support::sshd(Service::Flaky) else {
        return;
    };
    let _turn = FLAKY.lock().await;
    let mut fixture = FlakyConnection::new(sshd);
    let stopped_port = free_port();
    let auto = PortForward {
        auto_start: true,
        ..to_echo("stop-auto", stopped_port)
    };
    let deleted_port = free_port();
    let deleted = to_echo("delete-manual", deleted_port);
    fixture.host.forwards = vec![auto.clone(), deleted.clone()];
    let connection = fixture.connect().await;
    let forwarder = PortForwarder::new();
    assert!(forwarder
        .start_auto(Arc::clone(&connection), &fixture.host)
        .await
        .is_empty());
    forwarder
        .start(connection, &fixture.host.id, &deleted)
        .await
        .unwrap();

    fixture.drop_transport().await;
    wait_for_forward_loss(&forwarder, &auto).await;
    wait_for_forward_loss(&forwarder, &deleted).await;
    let replacement = fixture.connect().await;
    let pending = forwarder.start_auto(Arc::clone(&replacement), &fixture.host);

    // A pane already has a start request from before Stop and deletion.
    forwarder.stop(&auto.id);
    fixture.host.forwards.retain(|rule| rule.id != deleted.id);
    forwarder.forget(&deleted.id);
    assert!(pending.await.is_empty());
    assert!(forwarder
        .start_auto(Arc::clone(&replacement), &fixture.host)
        .await
        .is_empty());
    assert!(forwarder.list().is_empty());
    assert!(TcpStream::connect(("127.0.0.1", stopped_port))
        .await
        .is_err());
    assert!(TcpStream::connect(("127.0.0.1", deleted_port))
        .await
        .is_err());

    forwarder
        .start(replacement, &fixture.host.id, &auto)
        .await
        .unwrap();
    assert_eq!(
        round_trip(stopped_port, b"manual restart").await,
        b"manual restart"
    );
    fixture.drop_transport().await;
    wait_for_forward_loss(&forwarder, &auto).await;
    let replacement = fixture.connect().await;
    assert!(forwarder
        .start_auto(replacement, &fixture.host)
        .await
        .is_empty());
    assert_eq!(
        round_trip(stopped_port, b"auto restart").await,
        b"auto restart"
    );
    assert_eq!(forwarder.status(&deleted.id), ForwardStatus::Stopped);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_restore_reports_the_bind_error_and_does_not_retry_on_the_same_connection() {
    let Some(sshd) = support::sshd(Service::Flaky) else {
        return;
    };
    let _turn = FLAKY.lock().await;
    let mut fixture = FlakyConnection::new(sshd);
    let port = free_port();
    let rule = to_echo("recover-occupied", port);
    fixture.host.forwards.push(rule.clone());
    let connection = fixture.connect().await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&events);
    let forwarder =
        PortForwarder::with_listener(move |event| seen.lock().unwrap().push(event.status));
    forwarder
        .start(connection, &fixture.host.id, &rule)
        .await
        .unwrap();

    fixture.drop_transport().await;
    wait_for_forward_loss(&forwarder, &rule).await;
    let taken = StdListener::bind(("127.0.0.1", port)).unwrap();
    let replacement = fixture.connect().await;

    let failures = forwarder
        .start_auto(Arc::clone(&replacement), &fixture.host)
        .await;

    assert!(matches!(failures.as_slice(), [(id, ForwardError::PortInUse(_))] if id == &rule.id));
    let failed = ForwardStatus::Failed {
        reason: format!("port {port} on 127.0.0.1 is already in use"),
    };
    assert_eq!(forwarder.status(&rule.id), failed);
    drop(taken);
    assert!(forwarder
        .start_auto(replacement, &fixture.host)
        .await
        .is_empty());
    assert_eq!(forwarder.status(&rule.id), failed);
    assert_eq!(
        *events.lock().unwrap(),
        [ForwardStatus::Running, lost(), failed]
    );
}
