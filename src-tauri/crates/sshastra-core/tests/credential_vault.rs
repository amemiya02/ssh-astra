//! Saved passwords and key passphrases: a connect uses what the
//! CredentialVault holds for the Host and keeps what the user asked to save.
//! Runs against real OpenSSH servers in Docker (see `support`), with an
//! in-memory vault, never the developer's keychain.

mod support;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use sshastra_core::credentials::{
    CredentialKind, CredentialVault, MemoryVault, NoVault, VaultError,
};
use sshastra_core::hosts::{Host, HostAuth, HostDraft, HostId, HostStore};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::settings::SettingsStore;
use sshastra_core::ssh::{
    BoxFuture, ConnectError, ConnectionManager, HostKeyPrompt, PassphrasePrompt, PasswordPrompt,
    Prompter, Secret,
};
use support::{Service, Sshd};

/// Trusts host keys and answers password / passphrase prompts from a script,
/// recording each question (with whether saving was offered).
#[derive(Default)]
struct ScriptedPrompter {
    answers: Mutex<VecDeque<Secret>>,
    asked: Mutex<Vec<String>>,
}

impl ScriptedPrompter {
    fn answering(answers: impl IntoIterator<Item = Secret>) -> Arc<Self> {
        Arc::new(Self {
            answers: Mutex::new(answers.into_iter().collect()),
            asked: Mutex::default(),
        })
    }

    fn silent() -> Arc<Self> {
        Self::answering([])
    }

    fn record(&self, question: String) -> Option<Secret> {
        self.asked.lock().unwrap().push(question);
        self.answers.lock().unwrap().pop_front()
    }

    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
}

impl Prompter for ScriptedPrompter {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, bool> {
        Box::pin(async { true })
    }

    fn password(&self, prompt: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        let answer = self.record(format!(
            "password retry={} can_save={}",
            prompt.retry, prompt.can_save
        ));
        Box::pin(async move { answer })
    }

    fn passphrase(&self, prompt: PassphrasePrompt) -> BoxFuture<'_, Option<Secret>> {
        let answer = self.record(format!(
            "passphrase retry={} can_save={}",
            prompt.retry, prompt.can_save
        ));
        Box::pin(async move { answer })
    }
}

/// A config directory (known_hosts, HostStore) that lives for the test.
struct Fixture {
    dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
        }
    }

    /// A fresh manager, as after an app restart: no live Connections.
    fn manager(&self, vault: &Arc<dyn CredentialVault>) -> ConnectionManager {
        ConnectionManager::new(KnownHosts::new(self.dir.path().join("known_hosts")))
            .with_home_dir(self.dir.path())
            .with_vault(vault.clone())
    }

    fn path(&self) -> PathBuf {
        self.dir.path().to_path_buf()
    }
}

fn host(sshd: &Sshd, auth: HostAuth) -> Host {
    Host {
        id: HostId::from(format!("vault-{}", sshd.port)),
        name: "docker sshd".into(),
        address: sshd.host.clone(),
        port: sshd.port,
        user: sshd.user.into(),
        auth,
        jump_host: None,
        terminal_scheme: None,
        identities_only: false,
        forward_agent: false,
        default_directory: None,
        group_id: None,
        forwards: Vec::new(),
    }
}

fn passphrase_key() -> HostAuth {
    HostAuth::Key {
        identity_file: support::key("id_ed25519_passphrase"),
    }
}

fn memory_vault() -> Arc<dyn CredentialVault> {
    Arc::new(MemoryVault::default())
}

async fn connect(
    fx: &Fixture,
    vault: &Arc<dyn CredentialVault>,
    host: &Host,
    prompter: Arc<ScriptedPrompter>,
) -> Result<(), ConnectError> {
    fx.manager(vault).connect(host, prompter).await.map(drop)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_saved_password_is_used_next_time_without_asking() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let fx = Fixture::new();
    let vault = memory_vault();
    let host = host(&sshd, HostAuth::Password);

    let first = ScriptedPrompter::answering([Secret::saved(sshd.password)]);
    connect(&fx, &vault, &host, first.clone()).await.unwrap();
    assert_eq!(first.asked(), ["password retry=false can_save=true"]);

    let second = ScriptedPrompter::silent();
    connect(&fx, &vault, &host, second.clone()).await.unwrap();
    assert!(second.asked().is_empty(), "{:?}", second.asked());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_password_typed_without_save_is_asked_again() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let fx = Fixture::new();
    let vault = memory_vault();
    let host = host(&sshd, HostAuth::Password);

    let first = ScriptedPrompter::answering([Secret::new(sshd.password)]);
    connect(&fx, &vault, &host, first).await.unwrap();

    assert_eq!(vault.get(&host.id, CredentialKind::Password), Ok(None));
    let second = ScriptedPrompter::answering([Secret::new(sshd.password)]);
    connect(&fx, &vault, &host, second.clone()).await.unwrap();
    assert_eq!(second.asked(), ["password retry=false can_save=true"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_password_is_not_saved() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let fx = Fixture::new();
    let vault = memory_vault();
    let host = host(&sshd, HostAuth::Password);

    let prompter =
        ScriptedPrompter::answering([Secret::saved("wrong"), Secret::new(sshd.password)]);
    connect(&fx, &vault, &host, prompter).await.unwrap();

    assert_eq!(vault.get(&host.id, CredentialKind::Password), Ok(None));
}

#[tokio::test(flavor = "multi_thread")]
async fn clearing_the_saved_credentials_makes_the_next_connect_ask() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let fx = Fixture::new();
    let vault = memory_vault();
    let host = host(&sshd, HostAuth::Password);
    let first = ScriptedPrompter::answering([Secret::saved(sshd.password)]);
    connect(&fx, &vault, &host, first).await.unwrap();

    vault.clear(&host.id).unwrap();

    let second = ScriptedPrompter::answering([Secret::new(sshd.password)]);
    connect(&fx, &vault, &host, second.clone()).await.unwrap();
    assert_eq!(second.asked(), ["password retry=false can_save=true"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_saved_password_that_stopped_working_is_forgotten_and_asked_for() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let fx = Fixture::new();
    let vault = memory_vault();
    let host = host(&sshd, HostAuth::Password);
    vault
        .set(&host.id, CredentialKind::Password, "changed-on-server")
        .unwrap();

    let prompter = ScriptedPrompter::answering([Secret::new(sshd.password)]);
    connect(&fx, &vault, &host, prompter.clone()).await.unwrap();

    assert_eq!(prompter.asked(), ["password retry=true can_save=true"]);
    assert_eq!(vault.get(&host.id, CredentialKind::Password), Ok(None));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_saved_key_passphrase_is_used_next_time_without_asking() {
    let Some(sshd) = support::sshd(Service::KeyOnly) else {
        return;
    };
    let fx = Fixture::new();
    let vault = memory_vault();
    let host = host(&sshd, passphrase_key());

    let first = ScriptedPrompter::answering([Secret::saved(support::KEY_PASSPHRASE)]);
    connect(&fx, &vault, &host, first.clone()).await.unwrap();
    assert_eq!(first.asked(), ["passphrase retry=false can_save=true"]);

    let second = ScriptedPrompter::silent();
    connect(&fx, &vault, &host, second.clone()).await.unwrap();
    assert!(second.asked().is_empty(), "{:?}", second.asked());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_saved_key_passphrase_that_stopped_working_is_forgotten_and_asked_for() {
    let Some(sshd) = support::sshd(Service::KeyOnly) else {
        return;
    };
    let fx = Fixture::new();
    let vault = memory_vault();
    let host = host(&sshd, passphrase_key());
    vault
        .set(&host.id, CredentialKind::KeyPassphrase, "old phrase")
        .unwrap();

    let prompter = ScriptedPrompter::answering([Secret::new(support::KEY_PASSPHRASE)]);
    connect(&fx, &vault, &host, prompter.clone()).await.unwrap();

    assert_eq!(prompter.asked(), ["passphrase retry=true can_save=true"]);
    assert_eq!(vault.get(&host.id, CredentialKind::KeyPassphrase), Ok(None));
}

#[tokio::test]
async fn a_default_key_passphrase_can_be_saved_and_used_after_reconnect() {
    let Some(sshd) = support::sshd(Service::KeyOnly) else {
        return;
    };
    let fx = Fixture::new();
    let ssh_dir = fx.path().join(".ssh");
    std::fs::create_dir(&ssh_dir).unwrap();
    std::fs::copy(
        support::key("id_ed25519_passphrase"),
        ssh_dir.join("id_ed25519"),
    )
    .unwrap();
    let vault = memory_vault();
    let host = host(&sshd, HostAuth::Auto);

    let first = ScriptedPrompter::answering([Secret::saved(support::KEY_PASSPHRASE)]);
    connect(&fx, &vault, &host, first.clone()).await.unwrap();
    assert_eq!(first.asked(), ["passphrase retry=false can_save=true"]);
    assert_eq!(
        vault.get(&host.id, CredentialKind::KeyPassphrase),
        Ok(Some(support::KEY_PASSPHRASE.to_owned()))
    );

    let second = ScriptedPrompter::silent();
    connect(&fx, &vault, &host, second.clone()).await.unwrap();
    assert!(second.asked().is_empty(), "{:?}", second.asked());
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_keychain_saving_is_not_offered_and_connects_still_work() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let fx = Fixture::new();
    let vault: Arc<dyn CredentialVault> = Arc::new(NoVault);
    let host = host(&sshd, HostAuth::Password);

    for _ in 0..2 {
        let prompter = ScriptedPrompter::answering([Secret::saved(sshd.password)]);
        connect(&fx, &vault, &host, prompter.clone()).await.unwrap();
        assert_eq!(prompter.asked(), ["password retry=false can_save=false"]);
    }
}

/// A keychain that fails every call, like a Secret Service that went away.
struct BrokenVault;

impl CredentialVault for BrokenVault {
    fn get(&self, _: &HostId, _: CredentialKind) -> Result<Option<String>, VaultError> {
        Err(VaultError("locked".into()))
    }
    fn set(&self, _: &HostId, _: CredentialKind, _: &str) -> Result<(), VaultError> {
        Err(VaultError("locked".into()))
    }
    fn delete(&self, _: &HostId, _: CredentialKind) -> Result<(), VaultError> {
        Err(VaultError("locked".into()))
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_keychain_never_breaks_a_connect() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let fx = Fixture::new();
    let vault: Arc<dyn CredentialVault> = Arc::new(BrokenVault);
    let host = host(&sshd, HostAuth::Password);

    let prompter = ScriptedPrompter::answering([Secret::saved(sshd.password)]);
    connect(&fx, &vault, &host, prompter.clone()).await.unwrap();
    assert_eq!(prompter.asked(), ["password retry=false can_save=true"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_credentials_never_reach_sshastras_own_files() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let Some(keyed) = support::sshd(Service::KeyOnly) else {
        return;
    };
    let fx = Fixture::new();
    let vault = memory_vault();
    let mut store = HostStore::open(fx.path().join("hosts.json")).unwrap();
    let password_host = store
        .upsert(None, draft(&sshd, HostAuth::Password))
        .unwrap();
    let key_host = store.upsert(None, draft(&keyed, passphrase_key())).unwrap();

    let prompter = ScriptedPrompter::answering([Secret::saved(sshd.password)]);
    connect(&fx, &vault, &password_host, prompter)
        .await
        .unwrap();
    let prompter = ScriptedPrompter::answering([Secret::saved(support::KEY_PASSPHRASE)]);
    connect(&fx, &vault, &key_host, prompter).await.unwrap();
    // Saving a Host again after its connect must not pick anything up.
    store
        .upsert(
            Some(password_host.id.clone()),
            draft(&sshd, HostAuth::Password),
        )
        .unwrap();

    assert_eq!(
        vault.get(&password_host.id, CredentialKind::Password),
        Ok(Some(sshd.password.to_owned()))
    );
    assert_eq!(
        vault.get(&key_host.id, CredentialKind::KeyPassphrase),
        Ok(Some(support::KEY_PASSPHRASE.to_owned()))
    );
    let mut settings = SettingsStore::open(fx.path().join("settings.json")).unwrap();
    settings
        .set("appearance", serde_json::json!({ "theme": "dark" }))
        .unwrap();

    let files = files_under(&fx.path());
    for name in ["hosts.json", "settings.json"] {
        assert!(files.iter().any(|f| f.ends_with(name)), "{files:?}");
    }
    for file in files {
        let text = String::from_utf8_lossy(&std::fs::read(&file).unwrap()).into_owned();
        for secret in [sshd.password, support::KEY_PASSPHRASE] {
            assert!(
                !text.contains(secret),
                "{} contains a credential",
                file.display()
            );
        }
    }
}

fn draft(sshd: &Sshd, auth: HostAuth) -> HostDraft {
    HostDraft {
        name: format!("docker {}", sshd.port),
        address: sshd.host.clone(),
        port: sshd.port,
        user: sshd.user.into(),
        auth,
        jump_host: None,
        terminal_scheme: None,
        identities_only: false,
        forward_agent: false,
        default_directory: None,
    }
}

fn files_under(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(files_under(&path));
        } else {
            files.push(path);
        }
    }
    files
}
