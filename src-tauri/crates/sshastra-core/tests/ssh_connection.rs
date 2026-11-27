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

use russh::keys::{decode_secret_key, PrivateKey};
use russh::server;
use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::{HostKey, KnownHosts};
use sshastra_core::ssh::{
    AuthMethod, BoxFuture, ConnectError, ConnectProgress, ConnectStage, Connection,
    ConnectionManager, HostKeyDecision, HostKeyPrompt, HostKeyRecord, PasswordPrompt,
    ProgressStatus, Prompter, RemoteTerminal, RemoteTerminalOptions, Secret,
};
use sshastra_core::terminal::{Terminal, TerminalEvent, TerminalSize};
use support::{Service, Sshd};
use tokio::net::TcpListener;

const OTHER_ED25519_KEY: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIcBDB1UjHN/eesqq7DdD1lWjjN3fCPWh4CoYJ5wJZ3R";

/// Answers prompts from a script and records what was asked.
struct ScriptedPrompter {
    trust_new_host: HostKeyDecision,
    passwords: Mutex<VecDeque<Option<String>>>,
    asked: Mutex<Vec<String>>,
    progress: Mutex<Vec<ConnectProgress>>,
}

impl ScriptedPrompter {
    fn new(trust_new_host: HostKeyDecision, passwords: &[Option<&str>]) -> Arc<Self> {
        Arc::new(Self {
            trust_new_host,
            passwords: Mutex::new(passwords.iter().map(|p| p.map(str::to_owned)).collect()),
            asked: Mutex::default(),
            progress: Mutex::default(),
        })
    }

    fn trusting(sshd: &Sshd) -> Arc<Self> {
        Self::new(HostKeyDecision::SaveAndTrust, &[Some(sshd.password)])
    }

    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
}

impl Prompter for ScriptedPrompter {
    fn progress(&self, progress: ConnectProgress) {
        self.progress.lock().unwrap().push(progress);
    }

    fn confirm_host_key(&self, prompt: HostKeyPrompt) -> BoxFuture<'_, HostKeyDecision> {
        self.asked.lock().unwrap().push(format!(
            "host key {}:{} {} {}",
            prompt.host, prompt.port, prompt.algorithm, prompt.fingerprint
        ));
        Box::pin(async move { self.trust_new_host })
    }

    fn password(&self, prompt: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        self.asked.lock().unwrap().push(format!(
            "password {}@{} retry={}",
            prompt.user, prompt.host, prompt.retry
        ));
        let answer = self
            .passwords
            .lock()
            .unwrap()
            .pop_front()
            .flatten()
            .map(Secret::new);
        Box::pin(async move { answer })
    }
}

#[tokio::test]
async fn detects_debian_once_per_saved_host_until_explicit_redetection() {
    use sshastra_core::hosts::{DetectedOs, HostStore};
    use sshastra_core::ssh::ConnectionSettings;

    let Some(sshd) = support::sshd(Service::Counted) else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hosts.json");
    let mut store = HostStore::open(&path).unwrap();
    let fixture = host(&sshd);
    let draft = serde_json::to_value(&fixture).unwrap();
    let target = store
        .insert(fixture.id, serde_json::from_value(draft.clone()).unwrap())
        .unwrap();
    let id = &target.id;
    let manager = ConnectionManager::new(KnownHosts::new(dir.path().join("known_hosts")));
    let before = sshd.command_sessions();
    let connection = manager
        .connect(&target, ScriptedPrompter::trusting(&sshd))
        .await
        .unwrap();
    let enabled = ConnectionSettings::default().detect_os;

    assert!(!store.begin_os_detection(id, false));
    assert_eq!(sshd.command_sessions(), before);
    assert!(store.begin_os_detection(id, enabled));
    let linked = manager
        .connect(&target, ScriptedPrompter::trusting(&sshd))
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&connection, &linked));
    assert!(!store.begin_os_detection(id, enabled));

    let mut edited = draft;
    edited["name"] = "Edited during detection".into();
    edited["icon"] = "router".into();
    store
        .upsert(Some(id.clone()), serde_json::from_value(edited).unwrap())
        .unwrap();
    let detected = connection.detect_os().await;
    assert!(store.finish_os_detection(id, detected).unwrap());
    assert_eq!(sshd.command_sessions(), before + 1);
    drop(linked);
    drop(connection);

    let mut reopened = HostStore::open(&path).unwrap();
    let persisted = reopened.get(id).unwrap();
    assert_eq!(persisted.detected_os, Some(DetectedOs::Debian));
    assert_eq!(persisted.name, "Edited during detection");
    assert_eq!(persisted.icon, Some(sshastra_core::hosts::HostIcon::Router));
    let connection = manager
        .connect(persisted, ScriptedPrompter::trusting(&sshd))
        .await
        .unwrap();
    assert!(!reopened.begin_os_detection(id, enabled));
    assert_eq!(sshd.command_sessions(), before + 1);

    assert!(reopened.clear_os_detection(id).unwrap());
    assert_eq!(
        HostStore::open(&path).unwrap().get(id).unwrap().detected_os,
        None
    );
    assert!(!reopened.begin_os_detection(id, false));
    assert_eq!(sshd.command_sessions(), before + 1);
    assert!(reopened.begin_os_detection(id, enabled));
    assert!(reopened
        .finish_os_detection(id, connection.detect_os().await)
        .unwrap());
    assert_eq!(
        HostStore::open(path).unwrap().get(id).unwrap().detected_os,
        Some(DetectedOs::Debian)
    );
    assert_eq!(sshd.command_sessions(), before + 2);
}

fn host(sshd: &Sshd) -> Host {
    host_at(&sshd.host, sshd.port, sshd.user)
}

fn host_at(address: &str, port: u16, user: &str) -> Host {
    Host {
        id: HostId::from(format!("it-{port}")),
        name: "docker sshd".into(),
        tags: Vec::new(),
        icon: None,
        detected_os: None,
        color: None,
        address: address.into(),
        port,
        user: user.into(),
        auth: HostAuth::Password,
        jump_host: None,
        terminal_scheme: None,
        identities_only: false,
        forward_agent: false,
        allow_legacy_algorithms: false,
        proxy: Default::default(),
        keepalive_seconds: None,
        post_login_command: None,
        terminal_charset: None,
        terminal_backspace: None,
        default_directory: None,
        forwards: Vec::new(),
        bookmarks: Vec::new(),
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
        "host key {}:{} {} {}",
        sshd.host,
        sshd.port,
        sshd.host_key.algorithm(),
        sshd.host_key.fingerprint()
    )
}

fn password_question(sshd: &Sshd, retry: bool) -> String {
    format!("password {}@{} retry={retry}", sshd.user, sshd.host)
}

#[tokio::test]
async fn legacy_algorithms_require_opt_in_before_host_key_verification_and_login() {
    let Some(sshd) = support::sshd(Service::Legacy) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let manager = kh.manager();
    let target = host(&sshd);
    let prompter = ScriptedPrompter::trusting(&sshd);

    let error = manager
        .connect(&target, prompter.clone())
        .await
        .expect_err("default settings must reject the legacy-only sshd");
    assert!(
        error.to_string().contains("No common Kex algorithm"),
        "{error}"
    );
    assert!(prompter.asked().is_empty());

    let enabled = Host {
        allow_legacy_algorithms: true,
        ..target
    };

    let declining = ScriptedPrompter::new(HostKeyDecision::Reject, &[]);
    let error = manager
        .connect(&enabled, declining.clone())
        .await
        .expect_err("the legacy host key still needs to be trusted");
    assert!(matches!(&error, ConnectError::HostKeyDeclined), "{error}");
    assert_eq!(declining.asked(), [host_key_question(&sshd)]);

    let connection = manager.connect(&enabled, prompter.clone()).await.unwrap();
    assert_eq!(
        prompter.asked(),
        [host_key_question(&sshd), password_question(&sshd, false)]
    );
    let output = connection.exec("hostname").await.unwrap();
    assert_eq!(output.status, 0);
    assert_eq!(output.stdout, b"legacy\n");
}

#[tokio::test]
async fn modern_algorithms_win_when_legacy_algorithms_are_also_offered() {
    let Some(sshd) = support::sshd(Service::Mixed) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let before = sshd.logs();
    let enabled = Host {
        allow_legacy_algorithms: true,
        ..host(&sshd)
    };
    let connection = kh
        .manager()
        .connect(&enabled, ScriptedPrompter::trusting(&sshd))
        .await
        .unwrap();
    assert_eq!(
        connection.exec("hostname").await.unwrap().stdout,
        b"mixed\n"
    );

    let logs = sshd.logs();
    let negotiation = logs.strip_prefix(&before).expect("appended sshd logs");
    for expected in [
        "kex: algorithm: curve25519-sha256",
        "kex: host key algorithm: ssh-ed25519",
        "kex: client->server cipher: aes128-ctr",
        "kex: server->client cipher: aes128-ctr",
    ] {
        assert!(
            negotiation.contains(expected),
            "missing {expected:?} in {negotiation}"
        );
    }
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
    let again = ScriptedPrompter::new(HostKeyDecision::Reject, &[Some(sshd.password)]);
    kh.manager()
        .connect(&host(&sshd), again.clone())
        .await
        .unwrap();
    assert_eq!(again.asked(), [password_question(&sshd, false)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn temporary_trust_survives_new_connections_but_not_a_new_manager() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let initial = b"# existing OpenSSH records\n";
    fs::write(&kh.path, initial).unwrap();
    let manager = kh.manager();
    let target = host(&sshd);
    let first = ScriptedPrompter::new(HostKeyDecision::TrustForRun, &[Some(sshd.password)]);
    drop(manager.connect(&target, first.clone()).await.unwrap());
    assert_eq!(
        first.asked(),
        [host_key_question(&sshd), password_question(&sshd, false)]
    );

    let next = ScriptedPrompter::new(HostKeyDecision::Reject, &[Some(sshd.password)]);
    drop(manager.connect(&target, next.clone()).await.unwrap());
    assert_eq!(next.asked(), [password_question(&sshd, false)]);

    let fresh = ScriptedPrompter::new(HostKeyDecision::Reject, &[]);
    let result = kh.manager().connect(&target, fresh.clone()).await;
    assert!(
        matches!(result, Err(ConnectError::HostKeyDeclined)),
        "{result:?}"
    );
    assert_eq!(fresh.asked(), [host_key_question(&sshd)]);
    assert_eq!(fs::read(&kh.path).unwrap().as_slice(), initial);
}

#[tokio::test(flavor = "multi_thread")]
async fn temporary_trust_is_scoped_to_the_host_and_endpoint() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let jump = support::sshd(Service::Jump).unwrap();
    // The OpenSSH fixtures reuse the same public key across these endpoints.
    assert_eq!(sshd.host_key, jump.host_key);
    let kh = KnownHostsFile::empty();
    let manager = kh.manager();
    let target = host(&sshd);
    let first = ScriptedPrompter::new(HostKeyDecision::TrustForRun, &[Some(sshd.password)]);
    manager
        .test_connection(&[], &target, first.clone())
        .await
        .unwrap();
    assert_eq!(
        first.asked(),
        [host_key_question(&sshd), password_question(&sshd, false)]
    );

    let mut other_host = target.clone();
    other_host.id = HostId::from("other-host".to_owned());
    let mut edited_endpoint = target.clone();
    edited_endpoint.port = jump.port;
    for (other, server) in [(&other_host, &sshd), (&edited_endpoint, &jump)] {
        let prompt = ScriptedPrompter::new(HostKeyDecision::Reject, &[]);
        let result = manager.connect(other, prompt.clone()).await;
        assert!(
            matches!(result, Err(ConnectError::HostKeyDeclined)),
            "{result:?}"
        );
        assert_eq!(prompt.asked(), [host_key_question(server)]);
    }

    let next = ScriptedPrompter::new(HostKeyDecision::Reject, &[Some(sshd.password)]);
    drop(manager.connect(&target, next.clone()).await.unwrap());
    assert_eq!(next.asked(), [password_question(&sshd, false)]);
    assert!(!kh.path.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn known_hosts_mismatch_and_revocation_take_precedence_over_temporary_trust() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let manager = kh.manager();
    let target = host(&sshd);
    let first = ScriptedPrompter::new(HostKeyDecision::TrustForRun, &[Some(sshd.password)]);
    drop(manager.connect(&target, first).await.unwrap());

    let prompt = ScriptedPrompter::new(HostKeyDecision::Reject, &[]);
    let endpoint = format!("[{}]:{}", sshd.host, sshd.port);
    fs::write(&kh.path, format!("{endpoint} {OTHER_ED25519_KEY}\n")).unwrap();
    let result = manager.connect(&target, prompt.clone()).await;
    assert!(
        matches!(
            result,
            Err(ConnectError::HostKeyMismatch {
                known: HostKeyRecord::KnownHosts(_),
                ..
            })
        ),
        "{result:?}"
    );

    fs::write(
        &kh.path,
        format!("@revoked {endpoint} {}\n", sshd.host_key.to_openssh()),
    )
    .unwrap();
    let result = manager.connect(&target, prompt.clone()).await;
    assert!(
        matches!(result, Err(ConnectError::HostKeyRevoked { .. })),
        "{result:?}"
    );
    assert!(prompt.asked().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn declining_an_unknown_host_key_stops_before_authentication() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let prompter = ScriptedPrompter::new(HostKeyDecision::Reject, &[Some(sshd.password)]);

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
            fingerprint,
            known: HostKeyRecord::KnownHosts(known),
            ..
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
    let prompter = ScriptedPrompter::new(
        HostKeyDecision::SaveAndTrust,
        &[Some("wrong"), Some(sshd.password)],
    );

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
    let prompter = ScriptedPrompter::new(HostKeyDecision::SaveAndTrust, &[None]);

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
        HostKeyDecision::SaveAndTrust,
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
        tags: Vec::new(),
        icon: None,
        detected_os: None,
        color: None,
        address: "127.0.0.1".into(),
        port,
        user: "x".into(),
        auth: HostAuth::Password,
        jump_host: None,
        terminal_scheme: None,
        identities_only: false,
        forward_agent: false,
        allow_legacy_algorithms: false,
        proxy: Default::default(),
        keepalive_seconds: None,
        post_login_command: None,
        terminal_charset: None,
        terminal_backspace: None,
        default_directory: None,
        forwards: Vec::new(),
        bookmarks: Vec::new(),
        group_id: None,
    };
    let prompter = ScriptedPrompter::new(HostKeyDecision::SaveAndTrust, &[]);

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

    let prompter = ScriptedPrompter::new(HostKeyDecision::Reject, &[Some(sshd.password)]);
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

async fn open_with_progress(
    jumps: Vec<Host>,
    target: Host,
    prompter: Arc<ScriptedPrompter>,
) -> RemoteTerminal {
    let kh = KnownHostsFile::empty();
    let manager = Arc::new(kh.manager());
    let prompts = prompter.clone();
    let shell_host = target.clone();
    RemoteTerminal::open_with_progress(
        move || {
            let (manager, jumps, target, prompts) = (
                manager.clone(),
                jumps.clone(),
                target.clone(),
                prompts.clone(),
            );
            async move { manager.connect_through(&jumps, &target, prompts).await }
        },
        RemoteTerminalOptions::default(),
        TerminalSize { cols: 80, rows: 24 },
        |_| {},
        shell_host,
        prompter,
    )
    .await
    .unwrap()
}

fn successful_steps(
    name: &str,
    jump_host: bool,
    stages: &[ConnectStage],
) -> Vec<(String, bool, ConnectStage, ProgressStatus)> {
    stages
        .iter()
        .flat_map(|&stage| {
            [ProgressStatus::Running, ProgressStatus::Succeeded]
                .map(|status| (name.to_owned(), jump_host, stage, status))
        })
        .collect()
}

fn reported_steps(
    prompter: &ScriptedPrompter,
) -> Vec<(String, bool, ConnectStage, ProgressStatus)> {
    prompter
        .progress
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event.status != ProgressStatus::Running || event.method.is_none())
        .map(|event| {
            (
                event.host_name.clone(),
                event.jump_host,
                event.stage,
                event.status,
            )
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_direct_terminal_reports_each_connection_step_in_order() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    use ConnectStage::*;
    let target = host(&sshd);
    let prompter = ScriptedPrompter::trusting(&sshd);
    let _terminal = open_with_progress(vec![], target.clone(), prompter.clone()).await;

    assert_eq!(
        reported_steps(&prompter),
        successful_steps(&target.name, false, &[Reach, HostKey, Authenticate, Shell])
    );
    assert!(prompter.progress.lock().unwrap().iter().any(|event| {
        event.stage == Authenticate
            && event.status == ProgressStatus::Running
            && event.method == Some(AuthMethod::Password)
    }));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_via_a_jump_host_reports_the_named_hops_in_order() {
    let Some(sshd) = support::sshd(Service::Jump) else {
        return;
    };
    use ConnectStage::*;
    let mut jump = host(&sshd);
    jump.name = "Office bastion".into();
    let target = behind("internal", &jump);
    let prompter = ScriptedPrompter::new(HostKeyDecision::SaveAndTrust, &[Some(sshd.password); 2]);
    let _terminal = open_with_progress(vec![jump.clone()], target.clone(), prompter.clone()).await;

    assert_eq!(
        reported_steps(&prompter),
        [
            successful_steps(&jump.name, true, &[Reach, HostKey, Authenticate]),
            successful_steps(&target.name, false, &[Reach, HostKey, Authenticate, Shell]),
        ]
        .concat()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rejected_password_ends_progress_at_the_failed_login_step() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let prompter = ScriptedPrompter::new(HostKeyDecision::SaveAndTrust, &[Some("incorrect"); 3]);

    let result = kh.manager().connect(&host(&sshd), prompter.clone()).await;

    assert!(
        matches!(result, Err(ConnectError::AuthenticationFailed)),
        "{result:?}"
    );
    let events = prompter.progress.lock().unwrap();
    let failed = events.last().expect("reported the failed step");
    assert_eq!(failed.stage, ConnectStage::Authenticate);
    assert_eq!(failed.status, ProgressStatus::Failed);
    assert_eq!(failed.method, Some(AuthMethod::Password));
}

/// Keeps the first attempt in flight at its visible host key prompt.
struct HostKeyGate {
    script: Arc<ScriptedPrompter>,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

impl Prompter for HostKeyGate {
    fn confirm_host_key(&self, prompt: HostKeyPrompt) -> BoxFuture<'_, HostKeyDecision> {
        Box::pin(async move {
            self.entered.notify_one();
            self.release.notified().await;
            self.script.confirm_host_key(prompt).await
        })
    }

    fn password(&self, prompt: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        self.script.password(prompt)
    }
}

struct AcceptNone;

impl server::Handler for AcceptNone {
    type Error = russh::Error;

    async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
}

#[tokio::test]
async fn a_conflicting_key_is_blocked_during_and_after_an_overlapping_private_test() {
    // Present two different keys on the same endpoint, including while a
    // previous prompt is still open. Only this test owns these SSH sessions.
    let old = decode_secret_key(include_str!("sshd/ssh_host_ed25519_key"), None).unwrap();
    let new = decode_secret_key(include_str!("sshd/keys/id_ed25519"), None).unwrap();
    let fingerprint = |key: &PrivateKey| HostKey::from(key.public_key().clone()).fingerprint();
    let old_fingerprint = fingerprint(&old);
    let new_fingerprint = fingerprint(&new);
    assert_ne!(old_fingerprint, new_fingerprint);
    let socket = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let mut target = host_at(
        "127.0.0.1",
        socket.local_addr().unwrap().port(),
        support::USER,
    );
    target.name = "rotating sshd".into();
    let server = tokio::spawn(async move {
        for key in [old.clone(), new, old] {
            let (stream, _) = socket.accept().await.unwrap();
            let config = server::Config {
                keys: vec![key],
                ..Default::default()
            };
            drop(
                server::run_stream(Arc::new(config), stream, AcceptNone)
                    .await
                    .unwrap(),
            );
        }
    });

    let kh = KnownHostsFile::empty();
    let manager = kh.manager();
    let gate = Arc::new(HostKeyGate {
        script: ScriptedPrompter::new(HostKeyDecision::SaveAndTrust, &[]),
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let other = async {
        gate.entered.notified().await;
        let prompt = ScriptedPrompter::new(HostKeyDecision::TrustForRun, &[]);
        drop(manager.connect(&target, prompt.clone()).await.unwrap());
        assert!(prompt.asked()[0].ends_with(&new_fingerprint));
        gate.release.notify_one();
    };
    let (private, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(manager.test_connection(&[], &target, gate.clone()), other)
    })
    .await
    .unwrap();

    let prompt = ScriptedPrompter::new(HostKeyDecision::Reject, &[]);
    let reconnect = manager.connect(&target, prompt.clone()).await.map(drop);
    for result in [private, reconnect] {
        match result {
            Err(ConnectError::HostKeyMismatch {
                fingerprint,
                known:
                    HostKeyRecord::ThisRun {
                        fingerprint: expected,
                    },
                ..
            }) => {
                assert_eq!(fingerprint, old_fingerprint);
                assert_eq!(expected, new_fingerprint);
            }
            other => panic!("expected a temporary host key mismatch, got {other:?}"),
        }
    }
    assert!(prompt.asked().is_empty());
    assert!(!kh.path.exists());
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_concurrent_connect_reports_waiting_before_reusing_the_connection() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let kh = KnownHostsFile::empty();
    let manager = kh.manager();
    let target = host(&sshd);
    let gate = Arc::new(HostKeyGate {
        script: ScriptedPrompter::trusting(&sshd),
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let prompter = ScriptedPrompter::new(HostKeyDecision::Reject, &[]);
    let follower = async {
        gate.entered.notified().await;
        let connect = manager.connect(&target, prompter.clone());
        tokio::pin!(connect);
        std::future::poll_fn(|cx| {
            use std::future::Future;
            assert!(connect.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        assert_eq!(
            reported_steps(&prompter),
            [(
                target.name.clone(),
                false,
                ConnectStage::Waiting,
                ProgressStatus::Running
            )]
        );
        gate.release.notify_one();
        connect.await.unwrap()
    };

    let (first, second) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(manager.connect(&target, gate.clone()), follower)
    })
    .await
    .unwrap();

    assert!(Arc::ptr_eq(&first.unwrap(), &second));
    assert_eq!(
        reported_steps(&prompter),
        [
            successful_steps(&target.name, false, &[ConnectStage::Waiting]),
            vec![(
                target.name,
                false,
                ConnectStage::Reused,
                ProgressStatus::Succeeded
            )],
        ]
        .concat()
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
                Ok(TerminalEvent::Cwd(_) | TerminalEvent::ShellIntegration(_)) => {}
                Ok(TerminalEvent::Connection(state)) => {
                    panic!("Connection {state:?} before {needle:?}: {}", self.text)
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
                Ok(
                    TerminalEvent::Output(_)
                    | TerminalEvent::Connection(_)
                    | TerminalEvent::Cwd(_)
                    | TerminalEvent::ShellIntegration(_),
                ) => {}
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
        tags: Vec::new(),
        icon: None,
        detected_os: None,
        color: None,
        address: name.into(),
        port: 22,
        user: support::USER.into(),
        auth: HostAuth::Password,
        jump_host: Some(jump.id.clone()),
        terminal_scheme: None,
        identities_only: false,
        forward_agent: false,
        allow_legacy_algorithms: false,
        proxy: Default::default(),
        keepalive_seconds: None,
        post_login_command: None,
        terminal_charset: None,
        terminal_backspace: None,
        default_directory: None,
        forwards: Vec::new(),
        bookmarks: Vec::new(),
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
    let prompter = ScriptedPrompter::new(HostKeyDecision::SaveAndTrust, &[Some(sshd.password); 2]);

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
    let prompter = ScriptedPrompter::new(HostKeyDecision::SaveAndTrust, &[Some(sshd.password); 3]);

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
    let prompter = ScriptedPrompter::new(HostKeyDecision::SaveAndTrust, &[Some(sshd.password); 2]);

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
    let prompter = ScriptedPrompter::new(
        HostKeyDecision::SaveAndTrust,
        &[Some("a"), Some("b"), Some("c")],
    );

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
    let prompter = ScriptedPrompter::new(HostKeyDecision::SaveAndTrust, &[Some(sshd.password)]);

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
