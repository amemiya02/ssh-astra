//! ProxyCommand integrated with the ConnectionManager and the local shell.

mod support;

#[cfg(unix)]
use std::fs;
use std::path::Path;
use std::sync::Arc;
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
use rustix::process::{test_kill_process, Pid};
use sshastra_core::hosts::{Host, HostDraft, HostStore};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{
    BoxFuture, ConnectError, ConnectionManager, HostKeyDecision, HostKeyPrompt, PasswordPrompt,
    Prompter, Secret,
};

#[cfg(unix)]
use sshastra_core::ssh::shell_quote;

struct Prompts;

impl Prompter for Prompts {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, HostKeyDecision> {
        Box::pin(async { HostKeyDecision::TrustForRun })
    }

    fn password(&self, _: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        Box::pin(async { Some(Secret::new(support::PASSWORD)) })
    }
}

fn host(dir: &Path, address: &str, port: u16, command: &str) -> Host {
    let mut store = HostStore::open(dir.join("hosts.json")).unwrap();
    let draft: HostDraft = serde_json::from_value(serde_json::json!({
        "name": "proxy-command-test",
        "address": address,
        "port": port,
        "user": support::USER,
        "auth": { "type": "password" },
        "proxy": {"mode":"proxyCommand", "config": command},
    }))
    .unwrap();
    store.upsert(None, draft).unwrap()
}

fn manager(dir: &Path) -> ConnectionManager {
    ConnectionManager::new(KnownHosts::new(dir.join("known_hosts")))
}

#[cfg(unix)]
async fn assert_stopped(path: &Path) {
    let pid = fs::read_to_string(path).unwrap().trim().parse().unwrap();
    let pid = Pid::from_raw(pid).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while test_kill_process(pid).is_ok() {
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .expect("ProxyCommand should have exited and been reaped");
}

#[cfg(unix)]
#[tokio::test]
async fn the_proxy_command_logs_in_to_openssh_and_stops_after_disconnect() {
    let Some(sshd) = support::sshd(support::Service::Ssh) else {
        return;
    };
    let temp = tempfile::tempdir().unwrap();
    let pid = temp.path().join("proxy.pid");
    let command = format!(
        "echo $$ > {}; exec nc %h %p",
        shell_quote(pid.to_str().unwrap())
    );
    let host = host(temp.path(), &sshd.host, sshd.port, &command);

    manager(temp.path())
        .test_connection(&[], &host, Arc::new(Prompts))
        .await
        .unwrap();
    assert_stopped(&pid).await;

    let manager = manager(temp.path());
    let connection = manager.connect(&host, Arc::new(Prompts)).await.unwrap();
    drop(connection);
    assert_stopped(&pid).await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_silent_command_times_out_and_stops() {
    let temp = tempfile::tempdir().unwrap();
    let pid = temp.path().join("proxy.pid");
    let command = format!(
        "echo $$ > {}; exec sleep 30",
        shell_quote(pid.to_str().unwrap())
    );
    let host = host(temp.path(), "localhost", 22, &command);
    let manager = manager(temp.path()).with_handshake_timeout(Duration::from_secs(1));

    let error = manager.connect(&host, Arc::new(Prompts)).await.unwrap_err();

    assert!(matches!(error, ConnectError::TimedOut), "{error:?}");
    assert_stopped(&pid).await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_command_reports_bounded_stderr_and_stops() {
    let temp = tempfile::tempdir().unwrap();
    let pid = temp.path().join("proxy.pid");
    let command = format!(
        "echo $$ > {}; echo 'fixture transport unavailable' >&2; printf '%%8192s' 'end of output' >&2; exit 7",
        shell_quote(pid.to_str().unwrap())
    );
    let host = host(temp.path(), "localhost", 22, &command);

    let error = manager(temp.path())
        .connect(&host, Arc::new(Prompts))
        .await
        .unwrap_err();

    assert!(
        matches!(error, ConnectError::ProxyCommandFailed { .. }),
        "{error:?}"
    );
    let message = error.to_string();
    assert!(
        message.contains("fixture transport unavailable"),
        "{message}"
    );
    assert!(!message.contains("end of output"));
    assert!(message.len() < 4300);
    assert_stopped(&pid).await;
}

#[cfg(windows)]
#[tokio::test]
async fn a_failed_proxy_command_reports_stderr_from_the_windows_shell() {
    let temp = tempfile::tempdir().unwrap();
    let command = "echo fixture transport unavailable 1>&2 & exit /b 7";
    let host = host(temp.path(), "localhost", 22, command);

    let error = manager(temp.path())
        .connect(&host, Arc::new(Prompts))
        .await
        .unwrap_err();

    assert!(
        matches!(error, ConnectError::ProxyCommandFailed { stderr } if stderr.contains("fixture transport unavailable"))
    );
}
