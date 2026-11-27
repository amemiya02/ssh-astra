//! How ConnectionManager authenticates: private key files, ssh-agent,
//! password and keyboard-interactive, against real OpenSSH servers in Docker
//! (see `support`).

mod support;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::KnownHosts;
#[cfg(unix)]
use sshastra_core::settings::SettingsStore;
#[cfg(unix)]
use sshastra_core::ssh::ConnectionSettings;
use sshastra_core::ssh::{
    Agent, BoxFuture, ConnectError, ConnectionManager, HostKeyDecision, HostKeyPrompt,
    KeyboardInteractivePrompt, PassphrasePrompt, PasswordPrompt, Prompter, Secret,
};
use support::{Service, Sshd};

/// Trusts the host key and answers every other question from a script,
/// recording what was asked. An exhausted script answers "cancel".
#[derive(Default)]
struct ScriptedPrompter {
    answers: Mutex<VecDeque<Option<Vec<String>>>>,
    asked: Mutex<Vec<String>>,
}

impl ScriptedPrompter {
    fn answering(answers: &[Option<&[&str]>]) -> Arc<Self> {
        let answers = answers
            .iter()
            .map(|a| a.map(|a| a.iter().map(|s| (*s).to_owned()).collect()))
            .collect();
        Arc::new(Self {
            answers: Mutex::new(answers),
            asked: Mutex::default(),
        })
    }

    fn silent() -> Arc<Self> {
        Self::answering(&[])
    }

    fn record(&self, question: String) -> Option<Vec<String>> {
        self.asked.lock().unwrap().push(question);
        self.answers.lock().unwrap().pop_front().flatten()
    }

    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
}

impl Prompter for ScriptedPrompter {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, HostKeyDecision> {
        Box::pin(async { HostKeyDecision::SaveAndTrust })
    }

    fn password(&self, prompt: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        let answer = self.record(format!("password retry={}", prompt.retry));
        Box::pin(async move { answer.map(|mut a| Secret::new(a.remove(0))) })
    }

    fn passphrase(&self, prompt: PassphrasePrompt) -> BoxFuture<'_, Option<Secret>> {
        let file = prompt.key_path.file_name().unwrap().to_string_lossy();
        let answer = self.record(format!("passphrase {file} retry={}", prompt.retry));
        Box::pin(async move { answer.map(|mut a| Secret::new(a.remove(0))) })
    }

    fn keyboard_interactive(
        &self,
        prompt: KeyboardInteractivePrompt,
    ) -> BoxFuture<'_, Option<Vec<String>>> {
        let questions: Vec<String> = prompt
            .prompts
            .iter()
            .map(|q| format!("{:?} echo={}", q.text, q.echo))
            .collect();
        let answer = self.record(format!(
            "keyboard-interactive {}@{} [{}]",
            prompt.user,
            prompt.host,
            questions.join(", ")
        ));
        Box::pin(async move { answer })
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    known_hosts: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let known_hosts = dir.path().join("known_hosts");
        Self { dir, known_hosts }
    }

    /// A manager that never consults the system ssh-agent or `~/.ssh`.
    fn manager(&self) -> ConnectionManager {
        ConnectionManager::new(KnownHosts::new(&self.known_hosts)).with_home_dir(self.dir.path())
    }

    fn default_key(&self, name: &str, fixture: &str) {
        let ssh_dir = self.dir.path().join(".ssh");
        std::fs::create_dir_all(&ssh_dir).unwrap();
        std::fs::copy(support::key(fixture), ssh_dir.join(name)).unwrap();
    }
}

fn host(sshd: &Sshd, auth: HostAuth) -> Host {
    Host {
        id: HostId::from(format!("auth-{}", sshd.port)),
        name: "docker sshd".into(),
        tags: Vec::new(),
        icon: None,
        detected_os: None,
        color: None,
        address: sshd.host.clone(),
        port: sshd.port,
        user: sshd.user.into(),
        auth,
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
        group_id: None,
    }
}

fn key_auth(path: impl AsRef<Path>) -> HostAuth {
    HostAuth::Key {
        identity_file: path.as_ref().to_path_buf(),
    }
}

async fn connect_with_key(name: &str) -> (Result<(), ConnectError>, Arc<ScriptedPrompter>) {
    connect_with_key_answering(name, ScriptedPrompter::silent()).await
}

/// Connects to the key-only server with the key fixture `name`. Without
/// Docker it returns `Ok` and the test checks nothing.
async fn connect_with_key_answering(
    name: &str,
    prompter: Arc<ScriptedPrompter>,
) -> (Result<(), ConnectError>, Arc<ScriptedPrompter>) {
    let Some(sshd) = support::sshd(Service::KeyOnly) else {
        return (Ok(()), prompter);
    };
    let fx = Fixture::new();
    let result = fx
        .manager()
        .connect(&host(&sshd, key_auth(support::key(name))), prompter.clone())
        .await
        .map(drop);
    (result, prompter)
}

fn docker() -> bool {
    support::sshd(Service::KeyOnly).is_some()
}

#[tokio::test]
async fn automatic_auth_uses_default_keys_even_with_identities_only_when_no_key_is_selected() {
    let Some(sshd) = support::sshd(Service::KeyOnly) else {
        return;
    };
    let fx = Fixture::new();
    fx.default_key("id_ed25519", "id_ed25519");
    let prompter = ScriptedPrompter::silent();
    let mut target = host(&sshd, HostAuth::Auto);
    target.identities_only = true;
    fx.manager()
        .connect(&target, prompter.clone())
        .await
        .unwrap();
    assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
}

#[tokio::test]
async fn automatic_auth_prefers_ed25519_then_ecdsa_then_rsa() {
    let Some(sshd) = support::sshd(Service::KeyOnly) else {
        return;
    };
    for (first, second) in [("id_ed25519", "id_ecdsa"), ("id_ecdsa", "id_rsa")] {
        let fx = Fixture::new();
        // The first path has an encrypted key, so its prompt reveals which
        // of the two authorized keys was tried first.
        fx.default_key(first, "id_ed25519_passphrase");
        fx.default_key(second, second);
        let prompter = ScriptedPrompter::answering(&[Some(&[support::KEY_PASSPHRASE])]);
        fx.manager()
            .connect(&host(&sshd, HostAuth::Auto), prompter.clone())
            .await
            .unwrap();
        assert_eq!(
            prompter.asked(),
            [format!("passphrase {first} retry=false")]
        );
    }
}

#[tokio::test]
async fn automatic_auth_skips_rejected_and_missing_defaults_before_rsa() {
    let Some(sshd) = support::sshd(Service::KeyOnly) else {
        return;
    };
    let fx = Fixture::new();
    fx.default_key("id_ed25519", "id_ed25519_unauthorized");
    fx.default_key("id_rsa", "id_rsa");
    fx.manager()
        .connect(&host(&sshd, HostAuth::Auto), ScriptedPrompter::silent())
        .await
        .unwrap();
}

#[tokio::test]
async fn automatic_auth_reports_no_usable_method_when_all_defaults_are_missing() {
    let Some(sshd) = support::sshd(Service::KeyOnly) else {
        return;
    };
    let prompter = ScriptedPrompter::silent();
    let result = Fixture::new()
        .manager()
        .connect(&host(&sshd, HostAuth::Auto), prompter.clone())
        .await;
    assert!(
        matches!(&result, Err(ConnectError::NoSupportedMethod { methods }) if methods == &["publickey"]),
        "{result:?}"
    );
    assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
}

#[tokio::test]
async fn a_rejected_named_key_never_falls_back_to_default_keys() {
    let Some(sshd) = support::sshd(Service::KeyOnly) else {
        return;
    };
    let fx = Fixture::new();
    fx.default_key("id_ed25519", "id_ed25519");
    let named = support::key("id_ed25519_unauthorized");
    let result = fx
        .manager()
        .connect(&host(&sshd, key_auth(&named)), ScriptedPrompter::silent())
        .await;
    assert!(
        matches!(&result, Err(ConnectError::KeyRejected { path }) if path == &named),
        "{result:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_ed25519_key_logs_in_without_asking_anything() {
    let (result, prompter) = connect_with_key("id_ed25519").await;
    result.unwrap();
    assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
}

#[tokio::test(flavor = "multi_thread")]
async fn ecdsa_and_rsa_keys_log_in_in_openssh_and_pem_formats() {
    for name in ["id_ecdsa", "id_rsa", "id_rsa_pem"] {
        let (result, prompter) = connect_with_key(name).await;
        result.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(
            prompter.asked().is_empty(),
            "{name}: {:?}",
            prompter.asked()
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_encrypted_key_asks_for_its_passphrase() {
    let prompter = ScriptedPrompter::answering(&[Some(&[support::KEY_PASSPHRASE])]);
    let (result, prompter) = connect_with_key_answering("id_ed25519_passphrase", prompter).await;
    result.unwrap();
    if docker() {
        assert_eq!(
            prompter.asked(),
            ["passphrase id_ed25519_passphrase retry=false"]
        );
    }
}

// The four PPK fixtures re-encode the authorized test id_ed25519 key.
#[tokio::test(flavor = "multi_thread")]
async fn unencrypted_putty_keys_can_log_in_without_a_passphrase() {
    for name in ["ed25519-v2-plain.ppk", "ed25519-v3-plain.ppk"] {
        let (result, prompter) = connect_with_key(name).await;
        result.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(
            prompter.asked().is_empty(),
            "{name}: {:?}",
            prompter.asked()
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn encrypted_putty_keys_can_log_in_after_a_passphrase_retry() {
    if !docker() {
        return;
    }
    for name in ["ed25519-v2-protected.ppk", "ed25519-v3-protected.ppk"] {
        let prompter = ScriptedPrompter::answering(&[
            Some(&["wrong passphrase"]),
            Some(&["sshastra-ppk-test-passphrase"]),
        ]);
        let (result, prompter) = connect_with_key_answering(name, prompter).await;
        result.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            prompter.asked(),
            [
                format!("passphrase {name} retry=false"),
                format!("passphrase {name} retry=true"),
            ]
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_passphrase_asks_again() {
    let prompter =
        ScriptedPrompter::answering(&[Some(&["nope"]), Some(&[support::KEY_PASSPHRASE])]);
    let (result, prompter) = connect_with_key_answering("id_ed25519_passphrase", prompter).await;
    result.unwrap();
    if docker() {
        assert_eq!(
            prompter.asked(),
            [
                "passphrase id_ed25519_passphrase retry=false",
                "passphrase id_ed25519_passphrase retry=true"
            ]
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn repeated_wrong_passphrases_say_the_passphrase_is_wrong() {
    if !docker() {
        return;
    }
    let prompter = ScriptedPrompter::answering(&[Some(&["a"]), Some(&["b"]), Some(&["c"])]);
    let (result, prompter) = connect_with_key_answering("id_ed25519_passphrase", prompter).await;
    match result {
        Err(ConnectError::KeyPassphraseIncorrect { path }) => {
            assert_eq!(path, support::key("id_ed25519_passphrase"))
        }
        other => panic!("expected a wrong passphrase, got {other:?}"),
    }
    assert_eq!(prompter.asked().len(), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_the_passphrase_cancels_the_connection() {
    if !docker() {
        return;
    }
    let (result, _) = connect_with_key("id_ed25519_passphrase").await;
    assert!(matches!(result, Err(ConnectError::Cancelled)), "{result:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_key_the_server_does_not_know_is_reported_as_rejected() {
    if !docker() {
        return;
    }
    let (result, _) = connect_with_key("id_ed25519_unauthorized").await;
    match result {
        Err(ConnectError::KeyRejected { path }) => {
            assert_eq!(path, support::key("id_ed25519_unauthorized"))
        }
        other => panic!("expected a rejected key, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_or_malformed_key_file_is_reported() {
    if !docker() {
        return;
    }
    for name in ["no_such_key", "authorized_keys", "malformed.ppk"] {
        let (result, prompter) = connect_with_key(name).await;
        assert!(
            matches!(&result, Err(ConnectError::KeyUnreadable { path, .. }) if path == &support::key(name)),
            "{name}: {result:?}"
        );
        assert!(
            prompter.asked().is_empty(),
            "{name}: {:?}",
            prompter.asked()
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn password_auth_skips_default_keys_on_a_key_only_server() {
    let Some(sshd) = support::sshd(Service::KeyOnly) else {
        return;
    };
    let prompter = ScriptedPrompter::silent();
    let fx = Fixture::new();
    fx.default_key("id_ed25519", "id_ed25519");
    let result = fx
        .manager()
        .connect(&host(&sshd, HostAuth::Password), prompter.clone())
        .await;
    match result {
        Err(ConnectError::NoSupportedMethod { methods }) => assert_eq!(methods, ["publickey"]),
        other => panic!("expected no usable method, got {other:?}"),
    }
    assert!(prompter.asked().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rejected_key_falls_back_to_the_password() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let prompter = ScriptedPrompter::answering(&[Some(&[sshd.password])]);
    let auth = key_auth(support::key("id_ed25519_unauthorized"));
    Fixture::new()
        .manager()
        .connect(&host(&sshd, auth), prompter.clone())
        .await
        .unwrap();
    assert_eq!(prompter.asked(), ["password retry=false"]);
}

#[tokio::test]
async fn an_explicit_key_logs_in_with_its_adjacent_user_certificate() {
    let Some(sshd) = support::sshd(Service::Certificate) else {
        return;
    };
    let fixture = Fixture::new();
    let key = fixture.dir.path().join("explicit.key");
    std::fs::copy(support::key("id_ed25519_certificate"), &key).unwrap();
    let certificate = key.with_file_name("explicit.key-cert.pub");
    std::fs::copy(
        support::key("id_ed25519_certificate-cert.pub"),
        &certificate,
    )
    .unwrap();
    let prompter = ScriptedPrompter::silent();
    let target = host(&sshd, key_auth(&key));

    fixture
        .manager()
        .connect(&target, prompter.clone())
        .await
        .unwrap();
    std::fs::remove_file(certificate).unwrap();
    let result = fixture.manager().connect(&target, prompter.clone()).await;
    assert!(
        matches!(&result, Err(ConnectError::KeyRejected { path }) if path == &key),
        "{result:?}"
    );
    assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
}

#[tokio::test]
async fn a_default_rsa_key_logs_in_with_its_adjacent_user_certificate() {
    let Some(sshd) = support::sshd(Service::Certificate) else {
        return;
    };
    let fixture = Fixture::new();
    fixture.default_key("id_rsa", "id_rsa");
    fixture.default_key("id_rsa-cert.pub", "id_rsa_certificate.pub");
    fixture
        .manager()
        .connect(&host(&sshd, HostAuth::Auto), ScriptedPrompter::silent())
        .await
        .unwrap();
}

#[tokio::test]
async fn rejected_user_certificates_fail_at_authentication() {
    let Some(sshd) = support::sshd(Service::Certificate) else {
        return;
    };
    let fixture = Fixture::new();
    let key = fixture.dir.path().join("identity");
    std::fs::copy(support::key("id_ed25519_certificate"), &key).unwrap();
    let certificate = key.with_file_name("identity-cert.pub");
    for name in [
        "id_ed25519_certificate-expired.pub",
        "id_ed25519_certificate-untrusted.pub",
        "id_rsa_certificate.pub",
    ] {
        std::fs::copy(support::key(name), &certificate).unwrap();
        let result = fixture
            .manager()
            .connect(&host(&sshd, key_auth(&key)), ScriptedPrompter::silent())
            .await;
        assert!(
            matches!(&result, Err(ConnectError::KeyRejected { path }) if path == &key),
            "{name}: {result:?}"
        );
    }
}

/// A private `ssh-agent` holding some of the key fixtures, stopped on drop.
#[cfg(unix)]
struct TestAgent {
    dir: tempfile::TempDir,
    process: std::process::Child,
}

#[cfg(unix)]
impl TestAgent {
    fn holding(keys: &[&str]) -> Self {
        use std::os::unix::fs::PermissionsExt;
        use std::process::{Command, Stdio};

        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("agent.sock");
        let process = Command::new("ssh-agent")
            .arg("-D")
            .arg("-a")
            .arg(&socket)
            .stdout(Stdio::null())
            .spawn()
            .expect("ssh-agent is needed for this test");
        let agent = Self { dir, process };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !socket.exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "ssh-agent did not start"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        for name in keys {
            // ssh-add refuses keys other users can read; git does not keep modes.
            let copy = agent.dir.path().join(name);
            std::fs::copy(support::key(name), &copy).unwrap();
            std::fs::set_permissions(&copy, std::fs::Permissions::from_mode(0o600)).unwrap();
            let certificate_name = format!("{name}-cert.pub");
            let certificate = support::key(&certificate_name);
            if certificate.is_file() {
                std::fs::copy(certificate, agent.dir.path().join(certificate_name)).unwrap();
            }
            let added = Command::new("ssh-add")
                .arg(&copy)
                .env("SSH_AUTH_SOCK", &socket)
                .output()
                .unwrap();
            assert!(added.status.success(), "{added:?}");
        }
        agent
    }

    fn manager(&self, fx: &Fixture) -> ConnectionManager {
        fx.manager().with_agent(Agent::Socket(self.socket()))
    }

    fn socket(&self) -> PathBuf {
        self.dir.path().join("agent.sock")
    }
}

#[cfg(unix)]
impl Drop for TestAgent {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_user_certificate_in_the_agent_logs_in_and_respects_identities_only() {
    let Some(sshd) = support::sshd(Service::Certificate) else {
        return;
    };
    let agent = TestAgent::holding(&["id_ed25519_unauthorized", "id_ed25519_certificate"]);
    let fixture = Fixture::new();
    let prompter = ScriptedPrompter::silent();
    agent
        .manager(&fixture)
        .connect(&host(&sshd, HostAuth::Auto), prompter.clone())
        .await
        .unwrap();

    // The named public key can filter agent identities but cannot sign itself.
    let mut target = host(&sshd, key_auth(support::key("id_ed25519_certificate.pub")));
    target.identities_only = true;
    agent
        .manager(&fixture)
        .connect(&target, prompter.clone())
        .await
        .unwrap();
    assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());

    target.auth = key_auth(support::key("id_ed25519_unauthorized"));
    let result = agent.manager(&fixture).connect(&target, prompter).await;
    assert!(
        matches!(result, Err(ConnectError::KeyRejected { .. })),
        "{result:?}"
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_key_in_the_agent_logs_in_without_asking_anything() {
    let Some(sshd) = support::sshd(Service::KeyOnly) else {
        return;
    };
    let agent = TestAgent::holding(&["id_ed25519_unauthorized", "id_rsa"]);
    let fx = Fixture::new();
    let prompter = ScriptedPrompter::silent();
    agent
        .manager(&fx)
        .connect(&host(&sshd, HostAuth::Password), prompter.clone())
        .await
        .unwrap();
    assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
}

#[cfg(unix)]
#[tokio::test]
async fn the_saved_agent_path_authenticates_and_a_missing_socket_falls_back_to_password() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let fixture = Fixture::new();
    let agent = TestAgent::holding(&["id_ed25519"]);
    let manager = fixture.manager().with_home_dir(agent.dir.path());
    let mut store = SettingsStore::open(fixture.dir.path().join("settings.json")).unwrap();
    let target = host(&sshd, HostAuth::Password);

    store
        .set(
            ConnectionSettings::SECTION,
            serde_json::json!({ "agentPath": "~/agent.sock" }),
        )
        .unwrap();
    manager.apply_settings(&store.section(ConnectionSettings::SECTION));
    let silent = ScriptedPrompter::silent();
    let connected = manager.connect(&target, silent.clone()).await.unwrap();
    assert!(silent.asked().is_empty(), "{:?}", silent.asked());

    store
        .set(
            ConnectionSettings::SECTION,
            serde_json::json!({ "agentPath": "~/missing-agent.sock" }),
        )
        .unwrap();
    manager.apply_settings(&store.section(ConnectionSettings::SECTION));
    let shared = manager.connect(&target, silent).await.unwrap();
    assert!(Arc::ptr_eq(&connected, &shared));

    let mut another = target;
    another.id = HostId::from("auth-fallback-after-agent-path-change".to_owned());
    let password = ScriptedPrompter::answering(&[Some(&[sshd.password])]);
    manager.connect(&another, password.clone()).await.unwrap();
    assert_eq!(password.asked(), ["password retry=false"]);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn agent_keys_are_tried_before_named_and_default_key_files() {
    let Some(sshd) = support::sshd(Service::KeyOnly) else {
        return;
    };
    let agent = TestAgent::holding(&["id_ed25519"]);
    let fx = Fixture::new();
    fx.default_key("id_ed25519", "id_ed25519_passphrase");
    // The files would need a passphrase; the agent key gets there first.
    for auth in [
        key_auth(support::key("id_ed25519_passphrase")),
        HostAuth::Auto,
    ] {
        let prompter = ScriptedPrompter::silent();
        agent
            .manager(&fx)
            .connect(&host(&sshd, auth), prompter.clone())
            .await
            .unwrap();
        assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
    }
}

/// Run a command in the real application shell. An exit status comes from
/// the command itself, and the fingerprint is absent from its input.
#[cfg(unix)]
#[tokio::test]
async fn agent_forwarding_lists_the_test_key_only_for_opted_in_hosts() {
    use sshastra_core::terminal::{Terminal, TerminalEvent, TerminalSize};

    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let test_public_key = russh::keys::load_public_key(support::key("id_ed25519.pub")).unwrap();
    let fingerprint = test_public_key.fingerprint(russh::keys::HashAlg::Sha256);
    let agent = TestAgent::holding(&["id_ed25519"]);
    let fixture = Fixture::new();
    let manager = fixture.manager();
    let configured = ConnectionSettings {
        agent_path: agent.socket().to_str().unwrap().to_owned(),
        ..ConnectionSettings::default()
    };
    let missing = ConnectionSettings {
        agent_path: fixture
            .dir
            .path()
            .join("missing-agent.sock")
            .to_str()
            .unwrap()
            .to_owned(),
        ..ConnectionSettings::default()
    };

    for forward in [false, true] {
        manager.apply_settings(&configured);
        let mut target = serde_json::to_value(host(&sshd, HostAuth::Password)).unwrap();
        target["forwardAgent"] = forward.into();
        target["id"] = format!("forward-agent-{forward}").into();
        let (status, output) = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let connection = manager
                .connect(
                    &serde_json::from_value(target).unwrap(),
                    ScriptedPrompter::silent(),
                )
                .await
                .unwrap();
            manager.apply_settings(&missing);
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let mut shell = connection
                .open_shell(
                    TerminalSize {
                        cols: 100,
                        rows: 24,
                    },
                    move |event| {
                        let _ = tx.send(event);
                    },
                )
                .await
                .unwrap();
            shell.write(b"LC_ALL=C ssh-add -l; exit $?\n").unwrap();
            let mut output = Vec::new();
            while let Some(event) = rx.recv().await {
                match event {
                    TerminalEvent::Output(bytes) => output.extend(bytes),
                    TerminalEvent::Exit { code } => {
                        return (code.unwrap(), String::from_utf8_lossy(&output).into_owned());
                    }
                    _ => {}
                }
            }
            panic!("no shell exit status");
        })
        .await
        .expect("ssh-add -l timed out");

        if forward {
            assert_eq!(status, 0, "{output}");
            assert!(output.contains(&fingerprint.to_string()), "{output}");
        } else {
            assert_eq!(status, 2, "{output}");
            assert!(!output.contains(&fingerprint.to_string()), "{output}");
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn identities_only_reaches_the_selected_agent_key_before_the_server_disconnects() {
    let Some(sshd) = support::sshd(Service::LimitedAuth) else {
        return;
    };
    let agent = TestAgent::holding(&["id_ecdsa", "id_rsa", "id_ed25519"]);
    let fx = Fixture::new();
    // With just the public file selected, only the agent can sign for it.
    let public_key = fx.dir.path().join("selected.pub");
    let text = std::fs::read_to_string(support::key("id_ed25519.pub")).unwrap();
    // Comments aren't part of the identity and need not agree with the agent.
    let key_fields = text
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    std::fs::write(&public_key, format!("{key_fields} selected-key\n")).unwrap();
    let mut target = host(&sshd, key_auth("~/selected.pub"));
    assert!(agent
        .manager(&fx)
        .connect(&target, ScriptedPrompter::silent())
        .await
        .is_err());

    target.identities_only = true;
    let prompter = ScriptedPrompter::silent();
    agent
        .manager(&fx)
        .connect(&target, prompter.clone())
        .await
        .unwrap();
    assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
}

#[cfg(unix)]
#[tokio::test]
async fn identities_only_skips_unrelated_agent_and_default_keys() {
    let Some(sshd) = support::sshd(Service::KeyOnly) else {
        return;
    };
    let fx = Fixture::new();
    fx.default_key("id_ed25519", "id_ed25519");
    let named = fx.dir.path().join("named");
    std::fs::copy(support::key("id_ed25519_unauthorized"), &named).unwrap();
    // A stale .pub file must not replace the selected file's public key.
    std::fs::copy(support::key("id_ed25519.pub"), named.with_extension("pub")).unwrap();
    let mut target = host(&sshd, key_auth(&named));
    target.identities_only = true;
    let agent = TestAgent::holding(&["id_ed25519"]);
    let result = agent
        .manager(&fx)
        .connect(&target, ScriptedPrompter::silent())
        .await;
    assert!(
        matches!(&result, Err(ConnectError::KeyRejected { path }) if path == &named),
        "{result:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn identities_only_uses_the_agent_for_encrypted_openssh_and_putty_keys() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    let Some(sshd) = support::sshd(Service::LimitedAuth) else {
        return;
    };
    let agent = TestAgent::holding(&["id_ecdsa", "id_rsa", "id_ed25519"]);
    let fx = Fixture::new();
    let openssh = fx.dir.path().join("encrypted-openssh");
    std::fs::copy(support::key("id_ed25519"), &openssh).unwrap();
    std::fs::set_permissions(&openssh, std::fs::Permissions::from_mode(0o600)).unwrap();
    let encrypted = Command::new("ssh-keygen")
        .args(["-p", "-P", "", "-N", support::KEY_PASSPHRASE, "-f"])
        .arg(&openssh)
        .output()
        .unwrap();
    assert!(encrypted.status.success(), "{encrypted:?}");

    for path in [
        openssh,
        support::key("ed25519-v2-protected.ppk"),
        support::key("ed25519-v3-protected.ppk"),
    ] {
        let mut target = host(&sshd, key_auth(&path));
        target.identities_only = true;
        let prompter = ScriptedPrompter::silent();
        agent
            .manager(&fx)
            .connect(&target, prompter.clone())
            .await
            .unwrap_or_else(|error| panic!("{path:?}: {error}"));
        assert!(prompter.asked().is_empty(), "{:?}", prompter.asked());
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn an_agent_with_only_unknown_keys_is_reported() {
    let Some(sshd) = support::sshd(Service::KeyOnly) else {
        return;
    };
    let agent = TestAgent::holding(&["id_ed25519_unauthorized"]);
    let fx = Fixture::new();
    let result = agent
        .manager(&fx)
        .connect(&host(&sshd, HostAuth::Password), ScriptedPrompter::silent())
        .await;
    assert!(
        matches!(result, Err(ConnectError::AgentKeysRejected)),
        "{result:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_agent_is_skipped() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let fx = Fixture::new();
    #[cfg(unix)]
    let agent = Agent::Socket(fx.known_hosts.with_file_name("no-agent.sock"));
    #[cfg(not(unix))]
    let agent = Agent::None;
    let prompter = ScriptedPrompter::answering(&[Some(&[sshd.password])]);
    fx.manager()
        .with_agent(agent)
        .connect(&host(&sshd, HostAuth::Password), prompter.clone())
        .await
        .unwrap();
    assert_eq!(prompter.asked(), ["password retry=false"]);
}

fn password_question(sshd: &Sshd) -> String {
    format!(
        "keyboard-interactive {}@{} [\"Password: \" echo=false]",
        sshd.user, sshd.host
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn keyboard_interactive_puts_the_servers_questions_to_the_user() {
    let Some(sshd) = support::sshd(Service::KbdInt) else {
        return;
    };
    let prompter = ScriptedPrompter::answering(&[Some(&[sshd.password])]);
    Fixture::new()
        .manager()
        .connect(&host(&sshd, HostAuth::Password), prompter.clone())
        .await
        .unwrap();
    assert_eq!(prompter.asked(), [password_question(&sshd)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn wrong_keyboard_interactive_answers_ask_again_then_fail() {
    let Some(sshd) = support::sshd(Service::KbdInt) else {
        return;
    };
    let prompter = ScriptedPrompter::answering(&[
        Some(&["a"]),
        Some(&["b"]),
        Some(&["c"]),
        Some(&[sshd.password]),
    ]);
    let result = Fixture::new()
        .manager()
        .connect(&host(&sshd, HostAuth::Password), prompter.clone())
        .await;
    assert!(
        matches!(result, Err(ConnectError::AuthenticationFailed)),
        "{result:?}"
    );
    assert_eq!(prompter.asked(), vec![password_question(&sshd); 3]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_key_accepted_as_a_first_step_goes_on_to_keyboard_interactive() {
    let Some(sshd) = support::sshd(Service::KbdInt) else {
        return;
    };
    let prompter = ScriptedPrompter::answering(&[Some(&[sshd.password])]);
    let auth = key_auth(support::key("id_ecdsa"));
    Fixture::new()
        .manager()
        .connect(&host(&sshd, auth), prompter.clone())
        .await
        .unwrap();
    assert_eq!(prompter.asked(), [password_question(&sshd)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_keyboard_interactive_cancels_the_connection() {
    let Some(sshd) = support::sshd(Service::KbdInt) else {
        return;
    };
    let result = Fixture::new()
        .manager()
        .connect(&host(&sshd, HostAuth::Password), ScriptedPrompter::silent())
        .await;
    assert!(matches!(result, Err(ConnectError::Cancelled)), "{result:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_accepted_key_skips_the_password() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let prompter = ScriptedPrompter::silent();
    let auth = key_auth(support::key("id_ed25519"));
    Fixture::new()
        .manager()
        .connect(&host(&sshd, auth), prompter.clone())
        .await
        .unwrap();
    assert!(prompter.asked().is_empty());
}
