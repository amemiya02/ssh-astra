#[path = "../crates/sshastra-core/tests/support/mod.rs"]
mod support;

use std::sync::Arc;
use std::time::Duration;

use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{
    BoxFuture, ConnectionManager, HostKeyDecision, HostKeyPrompt, PasswordPrompt, Prompter, Secret,
};
use sshastra_core::terminal::{Terminal, TerminalEvent, TerminalSize};

struct PasswordLogin;

const PASSWORD_MARKER: &str = "test-password-log-marker";
const INPUT_MARKER: &str = "test-terminal-input-marker";
const TERMINAL_MARKER: &str = "test-terminal-log-marker";

impl Prompter for PasswordLogin {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, HostKeyDecision> {
        Box::pin(async { HostKeyDecision::SaveAndTrust })
    }

    fn password(&self, _: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        Box::pin(async { Some(Secret::new(PASSWORD_MARKER)) })
    }
}

#[tokio::test]
async fn log_files_record_an_ssh_connection_without_password_or_terminal_data() {
    let Some(sshd) = support::sshd(support::Service::Ssh) else {
        return;
    };
    let sandbox = tempfile::tempdir().unwrap();
    let log_dir = sandbox.path().join("logs");
    crate::diagnostics::Logs::new(log_dir.clone())
        .install()
        .unwrap();

    let host = Host {
        id: HostId::from("logging-test".to_owned()),
        name: "Logging test host".to_owned(),
        tags: Vec::new(),
        icon: None,
        detected_os: None,
        color: None,
        address: sshd.host,
        port: sshd.port,
        user: "logtester".to_owned(),
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
        open_ssh_source: None,
    };
    let manager = ConnectionManager::new(KnownHosts::new(sandbox.path().join("known_hosts")));
    let connection = manager
        .connect(&host, Arc::new(PasswordLogin))
        .await
        .unwrap();
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let mut shell = connection
        .open_shell(TerminalSize { cols: 80, rows: 24 }, move |event| {
            let _ = send.send(event);
        })
        .await
        .unwrap();
    // Build the marker on the server so the echoed command line cannot match it.
    let command =
        format!("stty -echo; : '{INPUT_MARKER}'; printf '\\n%s%s\\n' test-terminal- log-marker\n");
    shell.write(command.as_bytes()).unwrap();
    let printed = tokio::time::timeout(Duration::from_secs(10), async {
        let mut output = Vec::new();
        while let Some(event) = receive.recv().await {
            match event {
                TerminalEvent::Output(bytes) => {
                    output.extend(bytes);
                    if String::from_utf8_lossy(&output).contains(TERMINAL_MARKER) {
                        return true;
                    }
                }
                TerminalEvent::Exit { .. } => break,
                _ => {}
            }
        }
        false
    })
    .await
    .unwrap();
    assert!(printed, "test Terminal did not produce its marker");
    shell.close().unwrap();

    let files = std::fs::read_dir(log_dir).unwrap();
    let mut logs = String::new();
    for entry in files {
        logs.push_str(&std::fs::read_to_string(entry.unwrap().path()).unwrap());
    }
    assert!(logs.contains("Logging test host"));
    assert!(logs.contains("authentication method=password result=accepted"));
    assert!(
        !logs.contains(PASSWORD_MARKER),
        "log files contain the test password"
    );
    assert!(
        !logs.contains(INPUT_MARKER),
        "log files contain the test Terminal input"
    );
    assert!(
        !logs.contains(TERMINAL_MARKER),
        "log files contain the test Terminal marker"
    );
}
