use std::io::{BufRead, Cursor};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;
use sshastra_core::agent::{
    AgentPermission, DirectoryRead, OpenTerminal, ReadError, ReadTarget, TerminalOrigin,
    TerminalScreen, TerminalStatus,
};
use sshastra_core::ssh::BoxFuture;
use sshastra_core::terminal::TerminalId;

use super::*;

struct TestBackend<F>(F);

impl<F: Fn() -> Vec<OpenTerminal> + Send + Sync> AgentBackend for TestBackend<F> {
    fn terminals(&self) -> Vec<OpenTerminal> {
        (self.0)()
    }

    fn target(&self, id: TerminalId) -> Option<ReadTarget> {
        (id == 12.into()).then(|| ReadTarget {
            terminal: id,
            host: String::from("build").into(),
            permission: AgentPermission::Read,
            status: TerminalStatus::Connected,
            generation: Some(0),
        })
    }

    fn read_screen(
        &self,
        _target: &ReadTarget,
        _lines: usize,
    ) -> BoxFuture<'_, Result<TerminalScreen, ReadError>> {
        Box::pin(async {
            Ok(TerminalScreen {
                screen: "rendered".into(),
                scrollback: "history".into(),
                truncated: false,
            })
        })
    }

    fn list_directory<'a>(
        &'a self,
        _target: &'a ReadTarget,
        _path: &'a str,
    ) -> BoxFuture<'a, Result<DirectoryRead, ReadError>> {
        Box::pin(async { panic!("unexpected directory read") })
    }

    fn read_file<'a>(
        &'a self,
        _target: &'a ReadTarget,
        _path: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u8>, ReadError>> {
        Box::pin(async { panic!("unexpected file read") })
    }
}

fn isolated_directory() -> tempfile::TempDir {
    // Unix-domain socket paths are usually limited to about 100 bytes.
    #[cfg(unix)]
    let directory = tempfile::Builder::new()
        .prefix("astra-")
        .tempdir_in("/tmp")
        .unwrap();
    #[cfg(windows)]
    let directory = tempfile::tempdir().unwrap();
    directory
}

#[test]
fn stdio_discovers_and_calls_the_read_tools_through_local_ipc() {
    let dir = isolated_directory();
    let endpoint = Endpoint::isolated(dir.path());
    let server = Server::start(
        &endpoint,
        Arc::new(TestBackend(|| {
            vec![OpenTerminal {
                id: 12.into(),
                origin: TerminalOrigin::Saved {
                    name: "Build".into(),
                    permission: AgentPermission::Read,
                },
                title: Some("work".into()),
                cwd: Some("/srv/test".into()),
                status: TerminalStatus::Connected,
            }]
        })),
    )
    .unwrap();
    server.active.store(true, Ordering::Release);

    let input = concat!(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\"}}\n",
        "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
        "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n",
        "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"list_terminals\"}}\n",
        "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"read_terminal\",\"arguments\":{\"terminalId\":12}}}\n",
    );
    let mut output = Vec::new();
    proxy_stdio(&endpoint, Cursor::new(input), &mut output).unwrap();
    let replies: Vec<Value> = BufRead::lines(Cursor::new(output))
        .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
        .collect();
    assert_eq!(replies.len(), 4);
    assert_eq!(replies[0]["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(replies[1]["result"]["tools"][0]["name"], "list_terminals");
    let listing: Value =
        serde_json::from_str(replies[2]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        listing,
        json!({"terminals":[{"id":12,"host":"Build","title":"work","cwd":"/srv/test","status":"connected"}]})
    );
    let screen: Value =
        serde_json::from_str(replies[3]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        screen,
        json!({"screen":"rendered","scrollback":"history","truncated":false})
    );
}

#[test]
fn a_stopped_server_closes_the_endpoint_and_returns_no_terminal_data() {
    let dir = isolated_directory();
    let endpoint = Endpoint::isolated(dir.path());
    let hits = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&hits);
    let server = Server::start(
        &endpoint,
        Arc::new(TestBackend(move || {
            count.fetch_add(1, Ordering::Relaxed);
            Vec::new()
        })),
    )
    .unwrap();
    server.active.store(true, Ordering::Release);
    let client = runtime().unwrap();
    let mut in_flight = client.block_on(endpoint.connect()).unwrap();
    client.block_on(in_flight.write_all(b"{")).unwrap();
    drop(server);
    let closed =
        client.block_on(async { tokio::time::timeout(REQUEST_TIMEOUT, in_flight.read_u8()).await });
    assert!(closed.unwrap().is_err());
    let mut output = Vec::new();
    let input = b"{\"jsonrpc\":\"2.0\",\"id\":42,\"method\":\"tools/call\",\"params\":{\"name\":\"list_terminals\"}}\n";
    proxy_stdio(&endpoint, Cursor::new(input), &mut output).unwrap();
    let response: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(response["id"], 42);
    assert_eq!(response["error"]["code"], -32000);
    assert_eq!(hits.load(Ordering::Relaxed), 0);
    #[cfg(unix)]
    assert!(!endpoint.socket().exists());
}

#[cfg(unix)]
#[test]
fn unix_socket_and_directory_are_private_and_a_second_server_cannot_replace_them() {
    use std::os::unix::fs::PermissionsExt;

    let dir = isolated_directory();
    let endpoint = Endpoint::isolated(dir.path());
    let server = Server::start(&endpoint, Arc::new(TestBackend(Vec::new))).unwrap();
    let socket = endpoint.socket();
    assert_eq!(
        socket.metadata().unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        socket
            .parent()
            .unwrap()
            .metadata()
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert!(Server::start(&endpoint, Arc::new(TestBackend(Vec::new))).is_err());

    drop(server);
    assert!(!socket.exists());
    assert!(Server::start(&endpoint, Arc::new(TestBackend(Vec::new))).is_ok());
}

#[test]
fn a_local_client_cannot_send_an_oversized_frame() {
    let dir = isolated_directory();
    let endpoint = Endpoint::isolated(dir.path());
    let server = Server::start(
        &endpoint,
        Arc::new(TestBackend(|| {
            panic!("oversized requests cannot read metadata")
        })),
    )
    .unwrap();
    server.active.store(true, Ordering::Release);
    runtime().unwrap().block_on(async {
        let mut client = endpoint.connect().await.unwrap();
        client
            .write_all(&vec![b'x'; MAX_REQUEST_BYTES + 1])
            .await
            .unwrap();
        assert!(tokio::time::timeout(REQUEST_TIMEOUT, client.read_u8())
            .await
            .unwrap()
            .is_err());
    });
}
