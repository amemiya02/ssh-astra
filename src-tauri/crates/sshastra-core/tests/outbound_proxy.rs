//! Outbound proxy routes against the dedicated Docker proxy and OpenSSH fixtures.

mod support;

use std::sync::{Arc, Mutex};

use sshastra_core::credentials::{CredentialKind, CredentialVault, MemoryVault};
use sshastra_core::hosts::{Host, HostDraft, HostStore};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::proxy::{HostProxy, ProxyConfig, ProxyKind};
use sshastra_core::settings::SettingsStore;
use sshastra_core::ssh::{
    BoxFuture, ConnectError, ConnectionManager, ConnectionSettings, HostKeyDecision, HostKeyPrompt,
    PasswordPrompt, Prompter, ProxyError, Secret,
};
use support::{Service, PROXY_PASSWORD, PROXY_TARGET, PROXY_USER};

#[derive(Default)]
struct Prompts {
    proxy_password: Option<Secret>,
    questions: Mutex<Vec<PasswordPrompt>>,
}

impl Prompter for Prompts {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, HostKeyDecision> {
        Box::pin(async { HostKeyDecision::TrustForRun })
    }

    fn password(&self, _: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        Box::pin(async { Some(Secret::new(support::PASSWORD)) })
    }

    fn proxy_password(&self, prompt: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        self.questions.lock().unwrap().push(prompt);
        Box::pin(async { self.proxy_password.clone() })
    }
}

fn add_host(store: &mut HostStore, address: &str, port: u16, proxy: HostProxy) -> Host {
    let draft: HostDraft = serde_json::from_value(serde_json::json!({
        "name": address,
        "address": address,
        "port": port,
        "user": support::USER,
        "auth": { "type": "password" },
        "proxy": proxy,
    }))
    .unwrap();
    store.upsert(None, draft).unwrap()
}

fn configure(
    manager: &ConnectionManager,
    settings: &mut SettingsStore,
    proxy: Option<&ProxyConfig>,
) {
    settings
        .set(
            ConnectionSettings::SECTION,
            serde_json::json!({ "proxy": proxy }),
        )
        .unwrap();
    manager.apply_settings(&settings.section(ConnectionSettings::SECTION));
}

#[tokio::test]
async fn a_proxy_applies_only_to_the_first_tcp_hop() {
    let Some(proxy) = support::outbound_proxy() else {
        return;
    };
    let direct = support::sshd(Service::Ssh).unwrap();
    let jump_server = support::sshd(Service::Jump).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let manager = ConnectionManager::new(KnownHosts::new(temp.path().join("known_hosts")));
    let mut settings = SettingsStore::open(temp.path().join("settings.json")).unwrap();
    let mut hosts = HostStore::open(temp.path().join("hosts.json")).unwrap();
    let target = add_host(&mut hosts, PROXY_TARGET, 22, HostProxy::Inherit);
    let prompts = Arc::new(Prompts::default());

    configure(&manager, &mut settings, None);
    assert!(matches!(
        manager.connect(&target, prompts.clone()).await,
        Err(ConnectError::Unreachable(_))
    ));

    for kind in [ProxyKind::Socks5, ProxyKind::HttpConnect] {
        configure(&manager, &mut settings, Some(&proxy.config(kind, false)));
        let connection = manager.connect(&target, prompts.clone()).await.unwrap();
        let output = connection.exec("hostname").await.unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), PROXY_TARGET);
    }

    let override_host = add_host(
        &mut hosts,
        PROXY_TARGET,
        22,
        HostProxy::Override(proxy.config(ProxyKind::Socks5, false)),
    );
    // This proxy only accepts connections to the dedicated fixture, so a
    // working Connection to the public sshd proves direct mode bypassed it.
    configure(
        &manager,
        &mut settings,
        Some(&proxy.config(ProxyKind::HttpConnect, true)),
    );
    manager
        .connect(&override_host, prompts.clone())
        .await
        .unwrap();
    let direct = add_host(&mut hosts, &direct.host, direct.port, HostProxy::Direct);
    let held = manager.connect(&direct, prompts.clone()).await.unwrap();
    assert!(Arc::ptr_eq(
        &held,
        &manager.connect(&direct, prompts.clone()).await.unwrap()
    ));
    let jump = add_host(
        &mut hosts,
        &jump_server.host,
        jump_server.port,
        HostProxy::Direct,
    );
    let internal = add_host(
        &mut hosts,
        "internal",
        22,
        HostProxy::Override(proxy.config(ProxyKind::HttpConnect, true)),
    );
    let connection = manager
        .connect_through(&[jump], &internal, prompts.clone())
        .await
        .unwrap();
    let output = connection.exec("hostname").await.unwrap();
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "internal");
    assert!(prompts.questions.lock().unwrap().is_empty());
}

#[tokio::test]
async fn authenticated_proxies_keep_successful_passwords_in_the_vault_only() {
    let Some(proxy) = support::outbound_proxy() else {
        return;
    };
    let temp = tempfile::tempdir().unwrap();
    let vault = Arc::new(MemoryVault::default());
    let manager = ConnectionManager::new(KnownHosts::new(temp.path().join("known_hosts")))
        .with_vault(vault.clone());
    let mut settings = SettingsStore::open(temp.path().join("settings.json")).unwrap();
    let mut hosts = HostStore::open(temp.path().join("hosts.json")).unwrap();
    let target = add_host(&mut hosts, PROXY_TARGET, 22, HostProxy::Inherit);

    for kind in [ProxyKind::Socks5, ProxyKind::HttpConnect] {
        let config = proxy.config(kind, true);
        configure(&manager, &mut settings, Some(&config));
        let wrong = Arc::new(Prompts {
            proxy_password: Some(Secret::saved("invalid-proxy-password")),
            ..Prompts::default()
        });
        assert!(matches!(
            manager.connect(&target, wrong).await,
            Err(ConnectError::Proxy(ProxyError::AuthenticationFailed))
        ));
        let right = Arc::new(Prompts {
            proxy_password: Some(Secret::saved(PROXY_PASSWORD)),
            ..Prompts::default()
        });
        manager.connect(&target, right.clone()).await.unwrap();
        let questions = right.questions.lock().unwrap();
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].user, PROXY_USER);
        assert!(questions[0].can_save);
        drop(questions);
        manager
            .connect(&target, Arc::new(Prompts::default()))
            .await
            .unwrap();
    }

    let own = add_host(
        &mut hosts,
        PROXY_TARGET,
        22,
        HostProxy::Override(proxy.config(ProxyKind::Socks5, true)),
    );
    let right = Arc::new(Prompts {
        proxy_password: Some(Secret::saved(PROXY_PASSWORD)),
        ..Prompts::default()
    });
    manager
        .test_connection(&[], &own, right.clone())
        .await
        .unwrap();
    assert!(!right.questions.lock().unwrap()[0].can_save);
    assert_eq!(
        vault.get(&own.id, CredentialKind::ProxyPassword).unwrap(),
        None
    );
    manager.connect(&own, right).await.unwrap();
    assert!(vault
        .get(&own.id, CredentialKind::ProxyPassword)
        .unwrap()
        .is_some());

    for file in ["settings.json", "hosts.json"] {
        let stored = std::fs::read_to_string(temp.path().join(file)).unwrap();
        assert!(!stored.contains(PROXY_PASSWORD));
        assert!(!stored.contains("invalid-proxy-password"));
    }
    assert!(!hosts.export().contains(PROXY_PASSWORD));
}
