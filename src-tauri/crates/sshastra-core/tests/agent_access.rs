use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde_json::{json, Value};
use sshastra_core::agent::{
    dispatch, AgentBackend, AgentPermission, DirectoryRead, OpenTerminal, ReadError, ReadTarget,
    TerminalOrigin, TerminalScreen, TerminalStatus,
};
use sshastra_core::files::{FileEntry, FileKind};
use sshastra_core::ssh::BoxFuture;
use sshastra_core::terminal::TerminalId;

struct TestBackend<F> {
    snapshot: F,
    host_is_shared: AtomicBool,
    revoke_during_read: bool,
    generation: AtomicU64,
}

impl<F> TestBackend<F> {
    fn new(snapshot: F) -> Self {
        Self {
            snapshot,
            host_is_shared: AtomicBool::new(true),
            revoke_during_read: false,
            generation: AtomicU64::new(0),
        }
    }
}

impl<F: Fn() -> Vec<OpenTerminal> + Send + Sync> AgentBackend for TestBackend<F> {
    fn terminals(&self) -> Vec<OpenTerminal> {
        (self.snapshot)()
    }

    fn target(&self, id: TerminalId) -> Option<ReadTarget> {
        (self.host_is_shared.load(Ordering::Relaxed) && id == 4.into()).then(|| ReadTarget {
            terminal: id,
            host: String::from("build").into(),
            permission: AgentPermission::Read,
            status: TerminalStatus::Connected,
            generation: Some(self.generation.load(Ordering::Relaxed)),
        })
    }

    fn read_screen(
        &self,
        target: &ReadTarget,
        lines: usize,
    ) -> BoxFuture<'_, Result<TerminalScreen, ReadError>> {
        assert_eq!(target.terminal, 4.into());
        Box::pin(async move {
            tokio::task::yield_now().await;
            if self.revoke_during_read {
                self.host_is_shared.store(false, Ordering::Relaxed);
            }
            let (screen, scrollback) = match lines {
                1 => ("界".repeat(30_000), "older".into()),
                2 => ("visible\x1b\nlast".into(), "earlier\nrecent".into()),
                _ => panic!("unexpected scrollback argument"),
            };
            Ok(TerminalScreen {
                screen,
                scrollback,
                truncated: false,
            })
        })
    }

    fn list_directory<'a>(
        &'a self,
        target: &'a ReadTarget,
        path: &'a str,
    ) -> BoxFuture<'a, Result<DirectoryRead, ReadError>> {
        assert_eq!(target.host.to_string(), "build");
        Box::pin(async move {
            let (entries, suffix) = match path {
                "/sample" => (2, String::new()),
                "/many" => (150, String::new()),
                "/large-names" => (128, "界".repeat(109)),
                _ => panic!("unexpected directory path: {path}"),
            };
            let mut listing = DirectoryRead::default();
            for i in 0..entries {
                let added = listing.push(FileEntry {
                    name: format!("entry-{i}{suffix}"),
                    kind: FileKind::File,
                    size: 19,
                    modified: None,
                    permissions: None,
                    uid: None,
                    gid: None,
                    link_target: None,
                });
                if !added {
                    break;
                }
            }
            Ok(listing)
        })
    }

    fn read_file<'a>(
        &'a self,
        target: &'a ReadTarget,
        path: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u8>, ReadError>> {
        assert_eq!(target.host.to_string(), "build");
        Box::pin(async move {
            match path {
                "/sample" => Ok(b"synthetic file\n".to_vec()),
                "/binary" => Ok(vec![0xff, 0xfe, 97]),
                "/oversize" => Ok(vec![b'x'; 65_537]),
                "/moving" => {
                    tokio::task::yield_now().await;
                    self.generation.fetch_add(1, Ordering::Relaxed);
                    Ok(b"old Connection content".to_vec())
                }
                _ => panic!("unexpected file path: {path}"),
            }
        })
    }
}

async fn list(enabled: bool, snapshot: impl Fn() -> Vec<OpenTerminal> + Send + Sync) -> Value {
    let request =
        br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_terminals"}}"#;
    let response = dispatch(request, || enabled, &TestBackend::new(snapshot))
        .await
        .unwrap();
    assert_eq!(response["id"], 1);
    response_data(&response)
}

fn response_data(response: &Value) -> Value {
    serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
}

fn terminal(id: u64, origin: TerminalOrigin) -> OpenTerminal {
    OpenTerminal {
        id: id.into(),
        origin,
        title: Some("shell".into()),
        cwd: Some("/srv/test".into()),
        status: TerminalStatus::Connected,
    }
}

fn saved(id: &str, permission: AgentPermission) -> TerminalOrigin {
    TerminalOrigin::Saved {
        name: id.into(),
        permission,
    }
}

#[tokio::test]
async fn lists_only_terminals_on_opted_in_saved_hosts() {
    let off = list(false, || {
        panic!("a disabled service must never read metadata")
    })
    .await;
    assert_eq!(off, json!({"terminals":[]}));
    let live_permission = AtomicBool::new(true);
    let snapshot = || {
        vec![
            terminal(1, TerminalOrigin::Local),
            terminal(2, TerminalOrigin::Temporary),
            terminal(3, saved("private", AgentPermission::Off)),
            terminal(
                4,
                saved(
                    "build",
                    if live_permission.load(Ordering::Relaxed) {
                        AgentPermission::Read
                    } else {
                        AgentPermission::Off
                    },
                ),
            ),
            terminal(5, saved("staging", AgentPermission::Approval)),
        ]
    };
    assert_eq!(
        list(true, snapshot).await,
        json!({"terminals": [
            {"id":4,"host":"build","title":"shell","cwd":"/srv/test","status":"connected"},
            {"id":5,"host":"staging","title":"shell","cwd":"/srv/test","status":"connected"},
        ]})
    );
    live_permission.store(false, Ordering::Relaxed);
    assert_eq!(list(true, snapshot).await["terminals"][0]["id"], 5);
}

#[tokio::test]
async fn advertises_only_read_tools() {
    let request = br#"{"jsonrpc":"2.0","id":"mcp","method":"tools/list"}"#;
    let backend = TestBackend::new(Vec::new);
    let response = dispatch(request, || true, &backend).await.unwrap();
    assert_eq!(response["id"], "mcp");
    let tools = response["result"]["tools"].as_array().unwrap();
    assert_eq!(
        tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "list_terminals",
            "read_terminal",
            "list_directory",
            "read_file"
        ]
    );
    assert!(tools
        .iter()
        .all(|tool| tool["annotations"]["readOnlyHint"] == true));

    let request =
        br#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_file"}}"#;
    assert_eq!(
        dispatch(request, || true, &backend).await.unwrap()["error"]["code"],
        -32602
    );
}

async fn call(backend: &dyn AgentBackend, tool: &str, arguments: Value) -> Value {
    let request = json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":tool,"arguments":arguments}});
    dispatch(request.to_string().as_bytes(), || true, backend)
        .await
        .unwrap()
}

#[tokio::test]
async fn reads_the_screen_only_while_the_same_saved_terminal_is_shared() {
    let mut backend = TestBackend::new(Vec::new);
    let arguments = json!({"terminalId":4, "scrollbackLines":2});
    let reply = call(&backend, "read_terminal", arguments.clone()).await;
    assert_eq!(
        response_data(&reply),
        json!({"screen":"visible\nlast","scrollback":"earlier\nrecent","truncated":false})
    );

    let invalid = call(
        &backend,
        "read_terminal",
        json!({"terminalId":4,"scrollbackLines":501}),
    )
    .await;
    assert_eq!(invalid["error"]["code"], -32602);

    let oversized = call(
        &backend,
        "read_terminal",
        json!({"terminalId":4,"scrollbackLines":1}),
    )
    .await;
    let oversized = response_data(&oversized);
    assert_eq!(oversized["screen"].as_str().unwrap().len(), 65_535);
    assert_eq!(oversized["scrollback"], "o");
    assert_eq!(oversized["truncated"], true);

    backend.revoke_during_read = true;
    let revoked = call(&backend, "read_terminal", arguments.clone()).await;
    assert_eq!(revoked["result"]["isError"], true);
    assert!(!revoked.to_string().contains("earlier"));
    assert_eq!(call(&backend, "read_terminal", arguments).await, revoked);
}

#[tokio::test]
async fn lists_one_remote_directory_and_respects_both_entry_and_name_limits() {
    let backend = TestBackend::new(Vec::new);
    let list = |path: &'static str| {
        call(
            &backend,
            "list_directory",
            json!({"terminalId":4, "path":path}),
        )
    };
    let listing = response_data(&list("/sample").await);
    assert_eq!(listing["entries"].as_array().unwrap().len(), 2);
    assert_eq!(listing["entries"][0]["name"], "entry-0");
    assert_eq!(listing["entries"][1]["size"], 19);
    assert_eq!(listing["truncated"], false);

    let many = response_data(&list("/many").await);
    assert_eq!(many["entries"].as_array().unwrap().len(), 128);
    assert_eq!(many["truncated"], true);

    let names = response_data(&list("/large-names").await);
    let bytes: usize = names["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap().len())
        .sum();
    assert!(bytes <= 32_768);
    assert_eq!(names["truncated"], true);
}

#[tokio::test]
async fn reads_bounded_file_bytes_and_discards_results_when_the_connection_changes() {
    let backend = TestBackend::new(Vec::new);
    let read =
        |path: &'static str| call(&backend, "read_file", json!({"terminalId":4, "path":path}));
    assert_eq!(
        response_data(&read("/sample").await),
        json!({"encoding":"utf-8","data":"synthetic file\n","truncated":false})
    );
    assert_eq!(
        response_data(&read("/binary").await),
        json!({"encoding":"base64","data":"//5h","truncated":false})
    );

    let bounded = response_data(&read("/oversize").await);
    assert_eq!(bounded["data"].as_str().unwrap().len(), 65_536);
    assert_eq!(bounded["truncated"], true);

    let moved = read("/moving").await;
    assert_eq!(moved["result"]["isError"], true);
    assert!(!moved.to_string().contains("old Connection content"));

    backend.host_is_shared.store(false, Ordering::Relaxed);
    for name in ["list_directory", "read_file"] {
        let refused = call(
            &backend,
            name,
            json!({"terminalId":4,"path":"/never-visited"}),
        )
        .await;
        assert_eq!(refused["result"]["isError"], true);
        for invalid in [
            "relative".into(),
            "/contains\0nul".into(),
            format!("/{}", "界".repeat(1366)),
        ] {
            assert_eq!(
                call(&backend, name, json!({"terminalId":4,"path":invalid})).await["error"]["code"],
                -32602
            );
        }
    }
}
