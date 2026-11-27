use std::io::{BufRead, Cursor};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;
use sshastra_core::agent::{AgentPermission, TerminalOrigin, TerminalStatus};
use sshastra_core::hosts::HostId;

use super::*;

fn isolated_directory() -> tempfile::TempDir {
    // Unix-domain socket paths are usually limited to about 100 bytes.
    #[cfg(unix)]
    return tempfile::Builder::new().prefix("astra-").tempdir_in("/tmp").unwrap();
    #[cfg(windows)]
    tempfile::tempdir().unwrap()
}

#[test]
fn stdio_discovers_and_calls_the_tool_through_local_ipc() {
    let dir = isolated_directory();
    let endpoint = Endpoint::isolated(dir.path());
    let server = Server::start(&endpoint, Arc::new(|| {
        vec![OpenTerminal {
            id: 12.into(),
            origin: TerminalOrigin::Saved {
                host: HostId::from("h-test".to_owned()),
                name: "Build".into(),
                permission: AgentPermission::Read,
            },
            title: Some("work".into()),
            cwd: Some("/srv/test".into()),
            status: TerminalStatus::Connected,
        }]
    })).unwrap();
    server.active.store(true, Ordering::Release);

    let input = concat!(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\"}}\n",
        "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
        "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n",
        "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"list_terminals\"}}\n",
    );
    let mut output = Vec::new();
    proxy_stdio(&endpoint, Cursor::new(input), &mut output).unwrap();
    let replies: Vec<Value> = Cursor::new(output).lines()
        .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
        .collect();
    assert_eq!(replies.len(), 3);
    assert_eq!(replies[0]["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(replies[1]["result"]["tools"][0]["name"], "list_terminals");
    let listing: Value = serde_json::from_str(replies[2]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(listing, json!({"terminals":[{"id":12,"host":"Build","title":"work","cwd":"/srv/test","status":"connected"}]}));
}

#[test]
fn a_stopped_server_closes_the_endpoint_and_returns_no_terminal_data() {
    let dir = isolated_directory();
    let endpoint = Endpoint::isolated(dir.path());
    let hits = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&hits);
    let server = Server::start(&endpoint, Arc::new(move || {
        count.fetch_add(1, Ordering::Relaxed);
        Vec::new()
    })).unwrap();
    server.active.store(true, Ordering::Release);
    drop(server);
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
    let server = Server::start(&endpoint, Arc::new(Vec::new)).unwrap();
    let socket = endpoint.socket();
    assert_eq!(socket.metadata().unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(socket.parent().unwrap().metadata().unwrap().permissions().mode() & 0o777, 0o700);
    assert!(Server::start(&endpoint, Arc::new(Vec::new)).is_err());

    drop(server);
    assert!(!socket.exists());
    assert!(Server::start(&endpoint, Arc::new(Vec::new)).is_ok());
}
