use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use serde_json::{json, Value};
use sshastra_core::agent::{
    dispatch, AgentBackend, AgentPermission, ApprovedFileWrite, DirectoryRead, OpenTerminal,
    ReadError, ReadTarget, ReviewOutcome, TerminalOrigin, TerminalScreen, TerminalStatus,
};
use sshastra_core::agent::{dispatch_recording, AgentActivityLog};
use sshastra_core::files::{FileEntry, FileKind};
use sshastra_core::ssh::BoxFuture;
use sshastra_core::terminal::TerminalId;

struct TestBackend<F> {
    snapshot: F,
    host_is_shared: AtomicBool,
    revoke_during_read: bool,
    generation: AtomicU64,
    permission: AgentPermission,
    review: Option<ReviewOutcome>,
    file_approval: Option<ReviewOutcome>,
    reconnect_during_approval: bool,
    lose_publication_reply: bool,
    written: Mutex<Option<Vec<u8>>>,
}

impl<F> TestBackend<F> {
    fn new(snapshot: F) -> Self {
        Self {
            snapshot,
            host_is_shared: AtomicBool::new(true),
            revoke_during_read: false,
            generation: AtomicU64::new(0),
            permission: AgentPermission::Read,
            review: Some(ReviewOutcome::Unavailable),
            file_approval: Some(ReviewOutcome::Unavailable),
            reconnect_during_approval: false,
            lose_publication_reply: false,
            written: Mutex::new(None),
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
            host_name: "Build".into(),
            permission: self.permission,
            status: TerminalStatus::Connected,
            generation: Some(self.generation.load(Ordering::Relaxed)),
        })
    }

    fn request_command_review<'a>(
        &'a self,
        _target: &'a ReadTarget,
        command: String,
        _enabled: &'a (dyn Fn() -> bool + Sync),
        _deadline: tokio::time::Instant,
    ) -> BoxFuture<'a, ReviewOutcome> {
        assert_eq!(self.permission, AgentPermission::Approval);
        assert_eq!(command, "  printf '中文'  ");
        Box::pin(async move {
            match self.review {
                Some(outcome) => outcome,
                None => std::future::pending().await,
            }
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

    fn request_file_write_approval<'a>(
        &'a self,
        target: &'a ReadTarget,
        path: String,
        byte_length: usize,
        _enabled: &'a (dyn Fn() -> bool + Sync),
        _deadline: tokio::time::Instant,
    ) -> BoxFuture<'a, Result<ApprovedFileWrite<'a>, ReviewOutcome>> {
        assert_eq!(target.host_name, "Build");
        assert_eq!(self.permission, AgentPermission::Approval);
        assert_eq!(path, "/sample/ log.bin");
        assert_eq!(byte_length, 3);
        Box::pin(async move {
            match self.file_approval {
                Some(ReviewOutcome::Written) => {
                    if self.reconnect_during_approval {
                        self.generation.fetch_add(1, Ordering::Relaxed);
                    }
                    let write: ApprovedFileWrite<'_> = Box::new(|bytes, _, publication| {
                        Box::pin(async move {
                            publication.start();
                            *self.written.lock().unwrap() = Some(bytes);
                            if self.lose_publication_reply {
                                return std::future::pending().await;
                            }
                            ReviewOutcome::Written
                        })
                    });
                    Ok(write)
                }
                Some(outcome) => Err(outcome),
                None => std::future::pending().await,
            }
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
                "/unavailable" => Err(ReadError::PathUnavailable),
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
async fn advertises_read_tools_and_individually_reviewed_operations() {
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
            "read_file",
            "request_command_review",
            "write_file",
        ]
    );
    assert!(tools[..4]
        .iter()
        .all(|tool| tool["annotations"]["readOnlyHint"] == true));
    assert_eq!(tools[4]["annotations"]["readOnlyHint"], false);
    assert_eq!(tools[5]["annotations"]["readOnlyHint"], false);

    let request =
        br#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_file"}}"#;
    assert_eq!(
        dispatch(request, || true, &backend).await.unwrap()["error"]["code"],
        -32602
    );
}

#[tokio::test]
async fn writes_exact_bytes_only_after_the_host_and_user_allow_this_call() {
    let mut backend = TestBackend::new(Vec::new);
    let args = json!({"terminalId":4,"path":"/sample/ log.bin","data":"//5h"});
    let request = json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{
        "name":"write_file","arguments":args
    }});
    let frame = request.to_string();

    backend.file_approval = Some(ReviewOutcome::Written);
    let refused = dispatch(frame.as_bytes(), || true, &backend).await.unwrap();
    assert_eq!(response_data(&refused), json!({"outcome":"unavailable"}));
    assert_eq!(*backend.written.lock().unwrap(), None);

    backend.permission = AgentPermission::Approval;
    backend.file_approval = Some(ReviewOutcome::Rejected);
    let refused = dispatch(frame.as_bytes(), || true, &backend).await.unwrap();
    assert_eq!(response_data(&refused), json!({"outcome":"rejected"}));
    assert_eq!(*backend.written.lock().unwrap(), None);

    backend.file_approval = Some(ReviewOutcome::Written);
    let mut activity = None;
    let reply = dispatch_recording(frame.as_bytes(), || true, &backend, &mut activity)
        .await
        .unwrap();
    assert_eq!(response_data(&reply), json!({"outcome":"written"}));
    assert_eq!(
        *backend.written.lock().unwrap(),
        Some(vec![0xff, 0xfe, b'a'])
    );

    let directory = tempfile::tempdir().unwrap();
    let log = AgentActivityLog::new(directory.path().join("agent-activity"));
    let now = UNIX_EPOCH + Duration::from_secs(1_790_000_000);
    log.record(activity.unwrap(), now).unwrap();
    assert_eq!(
        serde_json::to_value(log.list(now, None).unwrap().records).unwrap(),
        json!([{"timestamp":1_790_000_000_000_u64,"tool":"write_file","host":"Build",
                "path":"/sample/ log.bin","outcome":"allowed"}])
    );
}

#[tokio::test(start_paused = true)]
async fn an_expired_file_write_proposal_never_writes() {
    let mut backend = TestBackend::new(Vec::new);
    backend.permission = AgentPermission::Approval;
    backend.file_approval = None;
    let reply = call(
        &backend,
        "write_file",
        json!({"terminalId":4,"path":"/sample/ log.bin","data":"//5h"}),
    )
    .await;
    assert_eq!(response_data(&reply), json!({"outcome":"timedOut"}));
    assert_eq!(*backend.written.lock().unwrap(), None);
}

#[tokio::test]
async fn approval_cannot_write_to_a_reconnected_terminal() {
    let mut backend = TestBackend::new(Vec::new);
    backend.permission = AgentPermission::Approval;
    backend.file_approval = Some(ReviewOutcome::Written);
    backend.reconnect_during_approval = true;
    let reply = call(
        &backend,
        "write_file",
        json!({"terminalId":4,"path":"/sample/ log.bin","data":"//5h"}),
    )
    .await;
    assert_eq!(response_data(&reply), json!({"outcome":"unavailable"}));
    assert_eq!(*backend.written.lock().unwrap(), None);
}

#[tokio::test(start_paused = true)]
async fn a_missing_publication_reply_is_reported_and_audited_as_unconfirmed() {
    let directory = tempfile::tempdir().unwrap();
    let log = AgentActivityLog::new(directory.path().join("agent-activity"));
    let now = UNIX_EPOCH + Duration::from_secs(1_790_000_000);
    let mut backend = TestBackend::new(Vec::new);
    backend.permission = AgentPermission::Approval;
    backend.file_approval = Some(ReviewOutcome::Written);
    backend.lose_publication_reply = true;
    let frame = json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{
        "name":"write_file","arguments":{"terminalId":4,"path":"/sample/ log.bin","data":"//5h"}
    }})
    .to_string();
    let mut activity = None;
    let reply = dispatch_recording(frame.as_bytes(), || true, &backend, &mut activity)
        .await
        .unwrap();
    assert_eq!(
        *backend.written.lock().unwrap(),
        Some(vec![0xff, 0xfe, b'a'])
    );
    assert_eq!(response_data(&reply), json!({"outcome":"writeUnconfirmed"}));
    log.record(activity.unwrap(), now).unwrap();
    let records = serde_json::to_value(log.list(now, None).unwrap().records).unwrap();
    assert_eq!(records[0]["outcome"], "unconfirmed");

    let mut interrupted = None;
    {
        let pending = dispatch_recording(frame.as_bytes(), || true, &backend, &mut interrupted);
        tokio::select! {
            biased;
            _ = pending => panic!("the rename reply is still pending"),
            _ = tokio::task::yield_now() => {}
        }
    }
    log.record(interrupted.unwrap(), now + Duration::from_secs(1))
        .unwrap();
    let records = serde_json::to_value(
        log.list(now + Duration::from_secs(1), None)
            .unwrap()
            .records,
    )
    .unwrap();
    assert_eq!(records[0]["outcome"], "unconfirmed");
}

#[tokio::test]
async fn invalid_file_writes_fail_before_requesting_approval() {
    let backend = TestBackend::new(Vec::new);
    for (path, data) in [
        ("/sample/ log.bin", "bad-base64".into()),
        ("/sample/ log.bin", "A".repeat(62_000)),
        ("/sample/visible\u{202e}.txt", "//5h".into()),
        ("/sample/../ambiguous.txt", "//5h".into()),
        ("/sample/dir/", "//5h".into()),
    ] {
        let reply = call(
            &backend,
            "write_file",
            json!({"terminalId":4,"path":path,"data":data}),
        )
        .await;
        assert_eq!(reply["error"]["code"], -32602);
    }
}

async fn call(backend: &dyn AgentBackend, tool: &str, arguments: Value) -> Value {
    let request = json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":tool,"arguments":arguments}});
    dispatch(request.to_string().as_bytes(), || true, backend)
        .await
        .unwrap()
}

#[tokio::test]
async fn more_than_five_hundred_unexpired_calls_are_available_across_pages_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("agent-activity");
    let log = AgentActivityLog::new(path.clone());
    let now = UNIX_EPOCH + Duration::from_secs(1_790_000_000);
    let backend = TestBackend::new(Vec::new);
    let request =
        br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_terminals"}}"#;
    for milliseconds in 0..517 {
        let mut activity = None;
        dispatch_recording(request, || true, &backend, &mut activity).await;
        log.record(activity.unwrap(), now + Duration::from_millis(milliseconds))
            .unwrap();
    }
    drop(log);
    let log = AgentActivityLog::new(path);
    let now = now + Duration::from_secs(1);
    let mut page = log.list(now, None).unwrap();
    assert!(page.next_before.is_some());
    assert!(page.records.len() < 517);
    let mut activity = None;
    dispatch_recording(request, || true, &backend, &mut activity).await;
    log.record(activity.unwrap(), now).unwrap();
    let mut records = Vec::new();
    loop {
        records.extend(page.records);
        let Some(before) = page.next_before else {
            break;
        };
        page = log.list(now, Some(before)).unwrap();
    }
    let timestamps: Vec<u64> = records
        .into_iter()
        .map(|record| {
            serde_json::to_value(record).unwrap()["timestamp"]
                .as_u64()
                .unwrap()
        })
        .collect();
    assert_eq!(
        timestamps,
        (1_790_000_000_000..1_790_000_000_517)
            .rev()
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn records_the_authorized_target_without_capturing_protocol_or_tool_output() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("agent-activity");
    let log = AgentActivityLog::new(path.clone());
    let now = UNIX_EPOCH + Duration::from_secs(1_790_000_000);
    let backend = TestBackend::new(Vec::new);
    let request = br#"{"jsonrpc":"2.0","id":"private-request-id","method":"tools/call","params":{"name":"read_file","arguments":{"terminalId":4,"path":"/sample"}}}"#;
    let mut activity = None;
    let response = dispatch_recording(request, || true, &backend, &mut activity)
        .await
        .unwrap();
    assert_eq!(response_data(&response)["data"], "synthetic file\n");
    log.record(activity.unwrap(), now).unwrap();
    let shard = std::fs::read_dir(path.join("records"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let saved = std::fs::read_to_string(&shard).unwrap();
    assert!(!saved.contains("private-request-id"));
    assert!(!saved.contains("synthetic file"));
    assert_eq!(
        serde_json::from_str::<Value>(&saved).unwrap(),
        json!([{"timestamp":1_790_000_000_000_u64,"tool":"read_file","host":"Build",
                "path":"/sample","outcome":"allowed"}])
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&shard).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}

#[tokio::test]
async fn activity_prunes_on_read_and_write_and_can_be_cleared() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("agent-activity");
    let log = AgentActivityLog::new(path.clone());
    let first = UNIX_EPOCH + Duration::from_secs(1_790_000_000);
    let day = Duration::from_secs(24 * 60 * 60);
    let second = first + Duration::from_secs(1);
    let boundary = first + 30 * day;
    let past_boundary = boundary + Duration::from_millis(1);
    let backend = TestBackend::new(Vec::new);
    let request =
        br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_terminals"}}"#;
    for time in [first - day, first, second] {
        let mut activity = None;
        dispatch_recording(request, || true, &backend, &mut activity).await;
        log.record(activity.unwrap(), time).unwrap();
    }
    drop(log);
    let log = AgentActivityLog::new(path.clone());
    // Startup expires whole days. Reading a page then prunes the cutoff day precisely.
    log.prune(boundary).unwrap();
    assert_eq!(log.list(boundary, None).unwrap().records.len(), 2);
    assert_eq!(log.list(past_boundary, None).unwrap().records.len(), 1);
    let disk = || {
        std::fs::read_dir(path.join("records"))
            .unwrap()
            .map(|entry| {
                let file = std::fs::read(entry.unwrap().path()).unwrap();
                serde_json::from_slice::<Vec<Value>>(&file).unwrap()
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(disk().iter().map(Vec::len).collect::<Vec<_>>(), [1]);

    let mut activity = None;
    dispatch_recording(request, || true, &backend, &mut activity).await;
    log.record(activity.unwrap(), past_boundary + day).unwrap();
    let persisted = disk();
    assert_eq!(persisted.iter().map(Vec::len).collect::<Vec<_>>(), [1]);
    assert_eq!(persisted[0][0]["tool"], "list_terminals");
    assert_eq!(persisted[0][0]["outcome"], "allowed");

    log.clear().unwrap();
    log.clear().unwrap();
    assert!(log
        .list(past_boundary + day, None)
        .unwrap()
        .records
        .is_empty());
    assert!(!path.join("records").exists());
    assert!(!path.join("cleared").exists());
}

#[tokio::test]
async fn activity_omits_unapproved_targets_and_unknown_tool_names() {
    let directory = tempfile::tempdir().unwrap();
    let log = AgentActivityLog::new(directory.path().join("agent-activity"));
    let now = UNIX_EPOCH + Duration::from_secs(1_790_000_000);
    let backend = TestBackend::new(Vec::new);
    for (tool, arguments) in [
        ("read_file", json!({"terminalId":19, "path":"/unapproved"})),
        (
            "list_directory",
            json!({"terminalId":4, "path":"not-absolute"}),
        ),
        (
            "arbitrary-client-supplied-name",
            json!({"extra":"private-payload"}),
        ),
        ("read_file", json!({"terminalId":4, "path":"/unavailable"})),
    ] {
        let request = json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":tool,"arguments":arguments}});
        let mut activity = None;
        dispatch_recording(
            request.to_string().as_bytes(),
            || true,
            &backend,
            &mut activity,
        )
        .await;
        log.record(activity.unwrap(), now).unwrap();
    }
    assert_eq!(
        serde_json::to_value(log.list(now, None).unwrap().records).unwrap(),
        json!([
            {"timestamp":1_790_000_000_000_u64,"tool":"read_file","host":"Build","path":"/unavailable","outcome":"failed"},
            {"timestamp":1_790_000_000_000_u64,"tool":"unknown","outcome":"failed"},
            {"timestamp":1_790_000_000_000_u64,"tool":"list_directory","outcome":"failed"},
            {"timestamp":1_790_000_000_000_u64,"tool":"read_file","outcome":"denied"}
        ])
    );
}

#[tokio::test(start_paused = true)]
async fn command_review_returns_only_the_single_request_outcome() {
    let mut backend = TestBackend::new(Vec::new);
    let arguments = json!({"terminalId":4,"command":"  printf '中文'  "});
    let review = "request_command_review";
    assert_eq!(
        response_data(&call(&backend, review, arguments.clone()).await),
        json!({"outcome":"unavailable"})
    );
    backend.permission = AgentPermission::Approval;
    assert_eq!(
        response_data(&call(&backend, review, arguments.clone()).await),
        json!({"outcome":"unavailable"})
    );

    backend.review = Some(ReviewOutcome::Copied);
    assert_eq!(
        response_data(&call(&backend, review, arguments.clone()).await),
        json!({"outcome":"copied"})
    );
    backend.review = Some(ReviewOutcome::Rejected);
    assert_eq!(
        response_data(&call(&backend, review, arguments.clone()).await),
        json!({"outcome":"rejected"})
    );

    backend.review = None;
    let started = tokio::time::Instant::now();
    assert_eq!(
        response_data(&call(&backend, review, arguments).await),
        json!({"outcome":"timedOut"})
    );
    assert_eq!(started.elapsed(), std::time::Duration::from_secs(120));
}

#[tokio::test]
async fn records_a_review_without_recording_the_proposed_command() {
    let directory = tempfile::tempdir().unwrap();
    let log = AgentActivityLog::new(directory.path().join("agent-activity"));
    let now = UNIX_EPOCH + Duration::from_secs(1_790_000_000);
    let mut backend = TestBackend::new(Vec::new);
    backend.permission = AgentPermission::Approval;
    backend.review = Some(ReviewOutcome::Copied);
    let request = json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{
        "name":"request_command_review","arguments":{"terminalId":4,"command":"  printf '中文'  "}
    }});
    let mut activity = None;
    let response = dispatch_recording(
        request.to_string().as_bytes(),
        || true,
        &backend,
        &mut activity,
    )
    .await
    .unwrap();
    assert_eq!(response_data(&response), json!({"outcome":"copied"}));
    log.record(activity.unwrap(), now).unwrap();
    assert_eq!(
        serde_json::to_value(log.list(now, None).unwrap().records).unwrap(),
        json!([{"timestamp":1_790_000_000_000_u64,"tool":"request_command_review","host":"Build",
                "outcome":"allowed"}])
    );
}

#[tokio::test]
async fn rejects_invisible_multiline_or_over_budget_command_proposals() {
    let mut backend = TestBackend::new(Vec::new);
    backend.permission = AgentPermission::Approval;
    for command in [
        "   ".into(),
        "pwd\u{2028}".into(),
        "pwd\u{200b}".into(),
        "pwd\u{202e}".into(),
        "pwd\n".into(),
        "pwd\r".into(),
        "a\tb".into(),
        "pwd\u{1b}".into(),
        "界".repeat(1366),
    ] {
        let reply = call(
            &backend,
            "request_command_review",
            json!({"terminalId":4,"command":command}),
        )
        .await;
        assert_eq!(reply["error"]["code"], -32602);
    }
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
