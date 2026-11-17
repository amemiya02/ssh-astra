//! ConnectionManager and remote Terminals against a real OpenSSH server in
//! Docker. Skipped when Docker is unavailable (see `support`).

mod support;

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{
    BoxFuture, ConnectError, Connection, ConnectionManager, HostKeyPrompt, PasswordPrompt, Prompter,
};
use sshastra_core::terminal::{Terminal, TerminalEvent, TerminalSize};
use support::{Service, Sshd};

const OTHER_ED25519_KEY: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIcBDB1UjHN/eesqq7DdD1lWjjN3fCPWh4CoYJ5wJZ3R";

/// Answers prompts from a script and records what was asked.
struct ScriptedPrompter {
    trust_new_host: bool,
    passwords: Mutex<VecDeque<Option<String>>>,
    asked: Mutex<Vec<String>>,
}

impl ScriptedPrompter {
    fn new(trust_new_host: bool, passwords: &[Option<&str>]) -> Arc<Self> {
        Arc::new(Self {
            trust_new_host,
            passwords: Mutex::new(passwords.iter().map(|p| p.map(str::to_owned)).collect()),
            asked: Mutex::default(),
        })
    }

    fn trusting(sshd: &Sshd) -> Arc<Self> {
        Self::new(true, &[Some(sshd.password)])
    }

    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
}

impl Prompter for ScriptedPrompter {
    fn confirm_host_key(&self, prompt: HostKeyPrompt) -> BoxFuture<'_, bool> {
        self.asked.lock().unwrap().push(format!(
            "host key {}:{} {} {}",
            prompt.host, prompt.port, prompt.algorithm, prompt.fingerprint
        ));
        Box::pin(async move { self.trust_new_host })
    }

    fn password(&self, prompt: PasswordPrompt) -> BoxFuture<'_, Option<String>> {
        self.asked.lock().unwrap().push(format!(
            "password {}@{} retry={}",
            prompt.user, prompt.host, prompt.retry
        ));
        let answer = self.passwords.lock().unwrap().pop_front().flatten();
        Box::pin(async move { answer })
    }
}

fn host(sshd: &Sshd) -> Host {
    Host {
        id: HostId::from(format!("it-{}", sshd.port)),
        name: "docker sshd".into(),
        address: sshd.host.clone(),
        port: sshd.port,
        user: sshd.user.into(),
        auth: HostAuth::Password,
        jump_host: None,
        terminal_scheme: None,
        group_id: None,
    }
}

struct KnownHostsFile {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

impl KnownHostsFile {
    fn empty() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        Self { _dir: dir, path }
    }

    fn manager(&self) -> ConnectionManager {
        ConnectionManager::new(KnownHosts::new(&self.path))
    }
}

fn host_key_question(sshd: &Sshd) -> String {
    format!(
        "host key {}:{} ssh-ed25519 {}",
        sshd.host,
        sshd.port,
        sshd.host_key.fingerprint()
    )
}

fn password_question(sshd: &Sshd, retry: bool) -> String {
    format!("password {}@{} retry={retry}", sshd.user, sshd.host)
}

#[tokio::test(flavor = "multi_thread")]
async fn first_connect_asks_to_trust_the_host_key_then_remembers_it() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let prompter = ScriptedPrompter::trusting(&sshd);

    let connection = kh
        .manager()
        .connect(&host(&sshd), prompter.clone())
        .await
        .unwrap();
    drop(connection);

    assert_eq!(
        prompter.asked(),
        [host_key_question(&sshd), password_question(&sshd, false)]
    );
    assert_eq!(
        fs::read_to_string(&kh.path).unwrap(),
        format!(
            "[{}]:{} {}\n",
            sshd.host,
            sshd.port,
            sshd.host_key.to_openssh()
        )
    );

    // A fresh manager (as after a restart) does not ask again.
    let again = ScriptedPrompter::new(false, &[Some(sshd.password)]);
    kh.manager()
        .connect(&host(&sshd), again.clone())
        .await
        .unwrap();
    assert_eq!(again.asked(), [password_question(&sshd, false)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn declining_an_unknown_host_key_stops_before_authentication() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let prompter = ScriptedPrompter::new(false, &[Some(sshd.password)]);

    let result = kh.manager().connect(&host(&sshd), prompter.clone()).await;

    assert!(
        matches!(result, Err(ConnectError::HostKeyDeclined)),
        "{result:?}"
    );
    assert_eq!(prompter.asked(), [host_key_question(&sshd)]);
    assert!(!kh.path.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_changed_host_key_blocks_the_connection_without_asking_anything() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let recorded = format!("[{}]:{} {OTHER_ED25519_KEY}\n", sshd.host, sshd.port);
    fs::write(&kh.path, &recorded).unwrap();
    let prompter = ScriptedPrompter::trusting(&sshd);

    let result = kh.manager().connect(&host(&sshd), prompter.clone()).await;

    match result {
        Err(ConnectError::HostKeyMismatch {
            fingerprint, known, ..
        }) => {
            assert_eq!(fingerprint, sshd.host_key.fingerprint());
            assert_eq!(
                known.fingerprint,
                "SHA256:24cOZtmpJuDzEPMb3bJGFzZoT/+00xaBsVgublFMlZs"
            );
            assert_eq!((known.path.as_path(), known.line), (kh.path.as_path(), 1));
        }
        other => panic!("expected a host key mismatch, got {other:?}"),
    }
    assert!(prompter.asked().is_empty());
    assert_eq!(fs::read_to_string(&kh.path).unwrap(), recorded);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_password_asks_again() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let prompter = ScriptedPrompter::new(true, &[Some("wrong"), Some(sshd.password)]);

    kh.manager()
        .connect(&host(&sshd), prompter.clone())
        .await
        .unwrap();

    assert_eq!(
        prompter.asked()[1..],
        [
            password_question(&sshd, false),
            password_question(&sshd, true)
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_the_password_prompt_cancels_the_connection() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let prompter = ScriptedPrompter::new(true, &[None]);

    let result = kh.manager().connect(&host(&sshd), prompter).await;

    assert!(matches!(result, Err(ConnectError::Cancelled)), "{result:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn repeated_wrong_passwords_fail_authentication() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let prompter = ScriptedPrompter::new(
        true,
        &[Some("a"), Some("b"), Some("c"), Some(sshd.password)],
    );

    let result = kh.manager().connect(&host(&sshd), prompter.clone()).await;

    assert!(
        matches!(result, Err(ConnectError::AuthenticationFailed)),
        "{result:?}"
    );
    assert_eq!(prompter.asked().len(), 1 + 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreachable_address_is_reported() {
    let kh = KnownHostsFile::empty();
    // Bind and drop to find a local port nobody listens on.
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut target = Host {
        id: HostId::from("nowhere".to_owned()),
        name: "nowhere".into(),
        address: "127.0.0.1".into(),
        port,
        user: "x".into(),
        auth: HostAuth::Password,
        jump_host: None,
        terminal_scheme: None,
        group_id: None,
    };
    let prompter = ScriptedPrompter::new(true, &[]);

    let result = kh.manager().connect(&target, prompter.clone()).await;
    assert!(
        matches!(result, Err(ConnectError::Unreachable(_))),
        "{result:?}"
    );

    target.address = "no-such-host.invalid".into();
    let result = kh.manager().connect(&target, prompter.clone()).await;
    assert!(
        matches!(result, Err(ConnectError::Unreachable(_))),
        "{result:?}"
    );
    assert!(prompter.asked().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn hosts_trusted_by_the_ssh_command_are_trusted_without_asking() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    // What `ssh` itself would have recorded, hashed (HashKnownHosts yes).
    let scanned = Command::new("ssh-keyscan")
        .args(["-t", "ed25519", "-p", &sshd.port.to_string(), &sshd.host])
        .output()
        .expect("ssh-keyscan is needed for this test");
    assert!(scanned.status.success());
    fs::write(&kh.path, &scanned.stdout).unwrap();
    let hashed = Command::new("ssh-keygen")
        .arg("-H")
        .arg("-f")
        .arg(&kh.path)
        .output()
        .unwrap();
    assert!(hashed.status.success());
    let recorded = fs::read_to_string(&kh.path).unwrap();
    assert!(recorded.lines().any(|l| l.starts_with("|1|")), "{recorded}");
    assert!(!recorded.lines().any(|l| l.starts_with('[')), "{recorded}");

    let prompter = ScriptedPrompter::new(false, &[Some(sshd.password)]);
    kh.manager()
        .connect(&host(&sshd), prompter.clone())
        .await
        .unwrap();

    assert_eq!(prompter.asked(), [password_question(&sshd, false)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn hosts_trusted_here_are_trusted_by_the_ssh_command() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    kh.manager()
        .connect(&host(&sshd), ScriptedPrompter::trusting(&sshd))
        .await
        .unwrap();

    let stderr = run_ssh_batch(&sshd, &kh.path);

    // Host key accepted; it then fails only at authentication (no password in batch mode).
    assert!(stderr.contains("Permission denied"), "ssh said: {stderr}");
    assert!(
        !stderr.contains("Host key verification failed"),
        "ssh said: {stderr}"
    );
}

fn run_ssh_batch(sshd: &Sshd, known_hosts: &Path) -> String {
    let output = Command::new("ssh")
        .args([
            "-F",
            "none",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
        ])
        .arg("-o")
        .arg(format!("UserKnownHostsFile={}", known_hosts.display()))
        .arg("-o")
        .arg(format!(
            "GlobalKnownHostsFile={}",
            known_hosts.with_file_name("none").display()
        ))
        .args(["-p", &sshd.port.to_string()])
        .arg(format!("{}@{}", sshd.user, sshd.host))
        .arg("true")
        .output()
        .expect("the ssh command is needed for this test");
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_same_host_shares_one_connection() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let manager = kh.manager();
    let prompter = ScriptedPrompter::trusting(&sshd);

    let first = manager
        .connect(&host(&sshd), prompter.clone())
        .await
        .unwrap();
    let second = manager
        .connect(&host(&sshd), prompter.clone())
        .await
        .unwrap();

    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(
        prompter.asked().len(),
        2,
        "authenticated once: {:?}",
        prompter.asked()
    );
}

/// Collects a remote Terminal's output as text.
struct Output {
    events: mpsc::Receiver<TerminalEvent>,
    text: String,
}

impl Output {
    fn sink() -> (impl FnMut(TerminalEvent) + Send + 'static, Self) {
        let (tx, rx) = mpsc::channel();
        let sink = move |event| {
            let _ = tx.send(event);
        };
        (
            sink,
            Self {
                events: rx,
                text: String::new(),
            },
        )
    }

    /// Waits until the output contains `needle`, returning everything after it.
    fn wait_for(&mut self, needle: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.text.contains(needle) {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.events.recv_timeout(left) {
                Ok(TerminalEvent::Output(bytes)) => {
                    self.text.push_str(&String::from_utf8_lossy(&bytes))
                }
                Ok(TerminalEvent::Exit { code }) => {
                    panic!("exited ({code:?}) before {needle:?}: {}", self.text)
                }
                Err(_) => panic!("timed out waiting for {needle:?}; got: {}", self.text),
            }
        }
        let at = self.text.find(needle).unwrap() + needle.len();
        self.text.drain(..at);
    }

    fn wait_for_exit(&mut self) -> Option<u32> {
        loop {
            match self.events.recv_timeout(Duration::from_secs(10)) {
                Ok(TerminalEvent::Output(_)) => {}
                Ok(TerminalEvent::Exit { code }) => break code,
                Err(_) => panic!("timed out waiting for exit"),
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_remote_terminal_runs_commands_and_follows_resizes() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let connection = kh
        .manager()
        .connect(&host(&sshd), ScriptedPrompter::trusting(&sshd))
        .await
        .unwrap();
    let (sink, mut out) = Output::sink();

    let mut shell = connection
        .open_shell(TerminalSize { cols: 80, rows: 24 }, sink)
        .await
        .unwrap();

    // Markers are built by the shell so the echoed command line never matches.
    shell
        .write(b"echo \"$TERM sum=$((40+2))\"; stty size\n")
        .unwrap();
    out.wait_for("xterm-256color sum=42");
    out.wait_for("24 80");

    // vim and tmux reflow on SIGWINCH plus the new size.
    shell
        .write(b"trap 'echo \"win\"ch=$(stty size)' WINCH\n")
        .unwrap();
    shell.write(b"echo ready-$((1+1))\n").unwrap();
    out.wait_for("ready-2");
    shell
        .resize(TerminalSize {
            cols: 132,
            rows: 40,
        })
        .unwrap();
    out.wait_for("winch=40 132");

    shell.write(b"exit 7\n").unwrap();
    assert_eq!(out.wait_for_exit(), Some(7));
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_a_remote_terminal_ends_its_shell() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let connection = kh
        .manager()
        .connect(&host(&sshd), ScriptedPrompter::trusting(&sshd))
        .await
        .unwrap();
    let (sink, mut out) = Output::sink();
    let mut shell = connection
        .open_shell(TerminalSize { cols: 80, rows: 24 }, sink)
        .await
        .unwrap();

    shell.close().unwrap();

    out.wait_for_exit();
}

/// A Host on the test's private networks, as its Jump host sees it.
fn behind(name: &str, jump: &Host) -> Host {
    Host {
        id: HostId::from(format!("it-{name}")),
        name: name.into(),
        address: name.into(),
        port: 22,
        user: support::USER.into(),
        auth: HostAuth::Password,
        jump_host: Some(jump.id.clone()),
        terminal_scheme: None,
        group_id: None,
    }
}

/// Asserts a shell on `connection` runs on the server named `hostname`.
async fn assert_lands_on(connection: &Arc<Connection>, hostname: &str) {
    let (sink, mut out) = Output::sink();
    let mut shell = connection
        .open_shell(TerminalSize { cols: 80, rows: 24 }, sink)
        .await
        .unwrap();
    shell.write(b"echo \"on-$(hostname)-$((1+1))\"\n").unwrap();
    out.wait_for(&format!("on-{hostname}-2"));
    shell.close().unwrap();
}

fn hop_questions(address: &str, port: u16, fingerprint: &str) -> [String; 2] {
    [
        format!("host key {address}:{port} ssh-ed25519 {fingerprint}"),
        format!("password {}@{address} retry=false", support::USER),
    ]
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_behind_one_jump_host_is_reached_through_it() {
    let Some(sshd) = support::sshd(Service::Jump) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let jump = host(&sshd);
    let internal = behind("internal", &jump);
    let prompter = ScriptedPrompter::new(true, &[Some(sshd.password); 2]);

    let connection = kh
        .manager()
        .connect_through(&[jump], &internal, prompter.clone())
        .await
        .unwrap();

    let fingerprint = sshd.host_key.fingerprint();
    assert_eq!(
        prompter.asked(),
        [
            hop_questions(&sshd.host, sshd.port, &fingerprint),
            hop_questions("internal", 22, &fingerprint),
        ]
        .concat()
    );
    assert_lands_on(&connection, "internal").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_behind_two_jump_hosts_is_reached_through_both() {
    let Some(sshd) = support::sshd(Service::Jump) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let jump = host(&sshd);
    let jump2 = behind("jump2", &jump);
    let deep = behind("deep", &jump2);
    let prompter = ScriptedPrompter::new(true, &[Some(sshd.password); 3]);

    let connection = kh
        .manager()
        .connect_through(&[jump, jump2], &deep, prompter.clone())
        .await
        .unwrap();

    let fingerprint = sshd.host_key.fingerprint();
    assert_eq!(
        prompter.asked(),
        [
            hop_questions(&sshd.host, sshd.port, &fingerprint),
            hop_questions("jump2", 22, &fingerprint),
            hop_questions("deep", 22, &fingerprint),
        ]
        .concat()
    );
    assert_lands_on(&connection, "deep").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_jump_host_connection_is_shared_with_the_jump_host_itself() {
    let Some(sshd) = support::sshd(Service::Jump) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let manager = kh.manager();
    let jump = host(&sshd);
    let internal = behind("internal", &jump);
    let prompter = ScriptedPrompter::new(true, &[Some(sshd.password); 2]);

    let _internal = manager
        .connect_through(std::slice::from_ref(&jump), &internal, prompter.clone())
        .await
        .unwrap();
    let direct = manager.connect(&jump, prompter.clone()).await.unwrap();

    assert_eq!(prompter.asked().len(), 4, "{:?}", prompter.asked());
    assert_lands_on(&direct, "jump").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_jump_host_is_named_in_the_error() {
    let Some(sshd) = support::sshd(Service::Jump) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let mut jump = host(&sshd);
    jump.name = "bastion".into();
    let internal = behind("internal", &jump);
    let prompter = ScriptedPrompter::new(true, &[Some("a"), Some("b"), Some("c")]);

    let result = kh
        .manager()
        .connect_through(std::slice::from_ref(&jump), &internal, prompter)
        .await;

    match result {
        Err(ConnectError::JumpHost { name, source }) => {
            assert_eq!(name, "bastion");
            assert!(
                matches!(*source, ConnectError::AuthenticationFailed),
                "{source:?}"
            );
        }
        other => panic!("expected a jump host error, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreachable_second_jump_host_is_named_in_the_error() {
    let Some(sshd) = support::sshd(Service::Jump) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let jump = host(&sshd);
    let mut missing = behind("missing", &jump);
    missing.address = "no-such-host.invalid".into();
    let internal = behind("internal", &missing);
    let prompter = ScriptedPrompter::new(true, &[Some(sshd.password)]);

    let result = kh
        .manager()
        .connect_through(&[jump, missing], &internal, prompter)
        .await;

    match result {
        Err(ConnectError::JumpHost { name, source }) => {
            assert_eq!(name, "missing");
            assert!(
                matches!(*source, ConnectError::Unreachable(_)),
                "{source:?}"
            );
        }
        other => panic!("expected a jump host error, got {other:?}"),
    }
}
