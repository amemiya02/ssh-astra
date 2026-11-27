//! Upgrading the app keeps the user's Hosts and settings: the files a released
//! version wrote (frozen copies in `tests/fixtures/<version>/`) still load, and
//! saving over them loses nothing.
//!
//! On every release whose file formats changed, add the previous release's
//! files as a new fixture folder and a test here; never edit an old fixture.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;
use sshastra_core::files::TransferSettings;
use sshastra_core::forward::ForwardKind;
use sshastra_core::hosts::{GroupId, HostAuth, HostDraft, HostId, HostStore};
use sshastra_core::settings::SettingsStore;
use sshastra_core::ssh::ConnectionSettings;
use sshastra_core::terminal::TerminalSettings;

/// A config dir holding the files `version` wrote.
fn config_dir_from(version: &str) -> tempfile::TempDir {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(version);
    let dir = tempfile::tempdir().unwrap();
    for name in ["hosts.json", "settings.json"] {
        fs::copy(fixtures.join(name), dir.path().join(name)).unwrap();
    }
    dir
}

fn hosts_path(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().join("hosts.json")
}

fn settings_path(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().join("settings.json")
}

fn id(raw: &str) -> HostId {
    HostId::from(raw.to_owned())
}

/// Everything the v0.1.0 hosts fixture holds.
fn assert_v0_1_0_hosts(store: &HostStore) {
    let names: Vec<_> = store.groups().iter().map(|g| g.name.as_str()).collect();
    assert_eq!(names, ["Production", "Databases"]);
    assert_eq!(
        store.groups()[1].parent_id,
        Some(GroupId::from("g-prod".to_owned()))
    );

    // In their saved order, ahead of any added since.
    let names: Vec<_> = store.list().iter().map(|h| h.name.as_str()).collect();
    assert_eq!(names[..3], ["bastion", "db-1", "pi"]);

    let bastion = store.get(&id("h-bastion")).unwrap();
    assert_eq!(
        bastion.auth,
        HostAuth::Key {
            identity_file: "~/.ssh/id_ed25519".into()
        }
    );
    assert_eq!(bastion.group_id, Some(GroupId::from("g-prod".to_owned())));
    assert!(bastion.forwards[0].auto_start);
    assert_eq!(
        bastion.forwards[0].kind,
        ForwardKind::Dynamic {
            bind_address: "127.0.0.1".into(),
            bind_port: 1080
        }
    );

    let db = store.get(&id("h-db")).unwrap();
    assert_eq!(
        (db.address.as_str(), db.port, db.user.as_str()),
        ("10.0.0.12", 2222, "postgres")
    );
    assert_eq!(db.jump_host, Some(id("h-bastion")));
    assert_eq!(db.terminal_scheme.as_deref(), Some("red-alert"));
    assert_eq!(db.default_directory.as_deref(), Some("/var/lib/postgresql"));
    assert_eq!(db.forwards.len(), 2);
    assert_eq!(db.forwards[1].label, "dev server");
    assert_eq!(
        db.forwards[1].kind,
        ForwardKind::Remote {
            bind_address: "localhost".into(),
            bind_port: 9000,
            local_host: "127.0.0.1".into(),
            local_port: 3000
        }
    );
    let chain: Vec<_> = store
        .jump_chain(&id("h-db"))
        .unwrap()
        .into_iter()
        .map(|h| h.name)
        .collect();
    assert_eq!(chain, ["bastion", "db-1"]);
}

#[test]
fn hosts_saved_by_v0_1_0_load_after_upgrading() {
    let dir = config_dir_from("v0.1.0");
    let store = HostStore::open(hosts_path(&dir)).unwrap();
    assert_v0_1_0_hosts(&store);
}

#[test]
fn saving_after_upgrading_from_v0_1_0_keeps_every_host() {
    let dir = config_dir_from("v0.1.0");
    let mut store = HostStore::open(hosts_path(&dir)).unwrap();
    store
        .upsert(
            None,
            HostDraft {
                name: "new".into(),
                tags: Vec::new(),
                icon: None,
                color: None,
                address: "10.0.0.99".into(),
                port: 22,
                user: "me".into(),
                auth: HostAuth::Password,
                jump_host: None,
                terminal_scheme: None,
                identities_only: false,
                forward_agent: false,
                proxy: Default::default(),
                keepalive_seconds: None,
                post_login_command: None,
                terminal_charset: None,
                terminal_backspace: None,
                default_directory: None,
            },
        )
        .unwrap();

    let reopened = HostStore::open(hosts_path(&dir)).unwrap();
    assert_eq!(reopened.list().len(), 4);
    assert_v0_1_0_hosts(&reopened);
}

#[test]
fn saving_automatic_auth_keeps_the_explicit_auth_of_v0_3_0_hosts() {
    let dir = tempfile::tempdir().unwrap();
    let path = hosts_path(&dir);
    fs::write(&path, include_str!("fixtures/v0.3.0/hosts.json")).unwrap();
    let mut store = HostStore::open(&path).unwrap();
    assert_eq!(
        store.get(&id("h-password")).unwrap().auth,
        HostAuth::Password
    );
    assert_eq!(
        store.get(&id("h-key")).unwrap().auth,
        HostAuth::Key {
            identity_file: "~/.ssh/build".into(),
        }
    );
    let mut expected = store.list().to_vec();
    expected.push(
        store
            .upsert(
                None,
                HostDraft {
                    name: "web".into(),
                    tags: Vec::new(),
                    icon: None,
                    color: None,
                    address: "web.example.com".into(),
                    port: 22,
                    user: "dev".into(),
                    auth: HostAuth::Auto,
                    jump_host: None,
                    terminal_scheme: None,
                    identities_only: false,
                    forward_agent: false,
                    proxy: Default::default(),
                    keepalive_seconds: None,
                    post_login_command: None,
                    terminal_charset: None,
                    terminal_backspace: None,
                    default_directory: None,
                },
            )
            .unwrap(),
    );

    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["version"], 17);
    assert_eq!(saved["hosts"][2]["auth"], json!({ "type": "auto" }));
    assert_eq!(HostStore::open(path).unwrap().list(), expected);
}

#[test]
fn version_6_hosts_keep_their_authentication_and_default_to_identities_only_off() {
    let dir = tempfile::tempdir().unwrap();
    let path = hosts_path(&dir);
    fs::write(&path, include_str!("fixtures/hosts-v6/hosts.json")).unwrap();
    let mut store = HostStore::open(&path).unwrap();
    let before = store.list().to_vec();
    assert_eq!(before[0].auth, HostAuth::Auto);
    assert_eq!(
        before[1].auth,
        HostAuth::Key {
            identity_file: "~/.ssh/build".into()
        }
    );
    assert_eq!(before[2].auth, HostAuth::Password);
    assert_eq!(before[1].default_directory.as_deref(), Some("/srv/build"));
    assert!(before.iter().all(|host| !host.identities_only));

    let mut draft = serde_json::to_value(&before[1]).unwrap();
    draft["identitiesOnly"] = true.into();
    let edited = store
        .upsert(
            Some(before[1].id.clone()),
            serde_json::from_value(draft).unwrap(),
        )
        .unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["version"], 17);
    assert_eq!(saved["hosts"][1]["identitiesOnly"], true);
    let reopened = HostStore::open(path).unwrap();
    assert_eq!(
        reopened.list(),
        &[before[0].clone(), edited, before[2].clone()]
    );
}

#[test]
fn version_8_hosts_inherit_global_keepalive_until_edited() {
    let dir = tempfile::tempdir().unwrap();
    let path = hosts_path(&dir);
    fs::write(&path, include_str!("fixtures/hosts-v8/hosts.json")).unwrap();
    let mut store = HostStore::open(&path).unwrap();
    let before = store.list().to_vec();
    assert!(before[1].forward_agent);

    let mut draft = serde_json::to_value(&before[1]).unwrap();
    draft["keepaliveSeconds"] = 0.into();
    let edited = store
        .upsert(
            Some(before[1].id.clone()),
            serde_json::from_value(draft).unwrap(),
        )
        .unwrap();

    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["version"], 17);
    assert!(saved["hosts"][0].get("keepaliveSeconds").is_none());
    assert_eq!(saved["hosts"][1]["keepaliveSeconds"], 0);
    assert!(saved["hosts"][2].get("keepaliveSeconds").is_none());
    assert_eq!(
        HostStore::open(path).unwrap().list(),
        &[before[0].clone(), edited, before[2].clone()]
    );
}

#[test]
fn version_9_hosts_have_no_post_login_command_until_edited() {
    let dir = tempfile::tempdir().unwrap();
    let path = hosts_path(&dir);
    fs::write(&path, include_str!("fixtures/hosts-v9/hosts.json")).unwrap();
    let mut store = HostStore::open(&path).unwrap();
    let before = store.list().to_vec();
    assert_eq!(before[1].keepalive_seconds, Some(0));
    assert!(before[1].forward_agent);

    let command = r#" printf '%s' "$HOME""#;
    let mut draft = serde_json::to_value(&before[1]).unwrap();
    draft["postLoginCommand"] = command.into();
    let edited = store
        .upsert(
            Some(before[1].id.clone()),
            serde_json::from_value(draft).unwrap(),
        )
        .unwrap();

    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["version"], 17);
    assert!(saved["hosts"][0].get("postLoginCommand").is_none());
    assert_eq!(saved["hosts"][1]["postLoginCommand"], command);
    assert!(saved["hosts"][2].get("postLoginCommand").is_none());
    assert_eq!(
        HostStore::open(path).unwrap().list(),
        &[before[0].clone(), edited, before[2].clone()]
    );
}

#[test]
fn version_10_hosts_keep_their_login_command_and_default_terminal_behavior() {
    let dir = tempfile::tempdir().unwrap();
    let path = hosts_path(&dir);
    fs::write(&path, include_str!("fixtures/hosts-v10/hosts.json")).unwrap();
    let mut store = HostStore::open(&path).unwrap();
    let before = store.list().to_vec();
    assert_eq!(
        before[1].post_login_command.as_deref(),
        Some(" printf '%s' \"$HOME\"")
    );

    let mut draft = serde_json::to_value(&before[1]).unwrap();
    assert!(draft.get("terminalCharset").is_none());
    assert!(draft.get("terminalBackspace").is_none());
    draft["terminalCharset"] = "gbk".into();
    draft["terminalBackspace"] = "ctrlH".into();
    let edited = store
        .upsert(
            Some(before[1].id.clone()),
            serde_json::from_value(draft).unwrap(),
        )
        .unwrap();

    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["version"], 17);
    assert!(saved["hosts"][0].get("terminalCharset").is_none());
    assert!(saved["hosts"][0].get("terminalBackspace").is_none());
    assert_eq!(saved["hosts"][1]["terminalCharset"], "gbk");
    assert_eq!(saved["hosts"][1]["terminalBackspace"], "ctrlH");
    assert_eq!(
        HostStore::open(path).unwrap().list(),
        &[before[0].clone(), edited, before[2].clone()]
    );
}

#[test]
fn version_7_hosts_keep_identities_only_and_default_to_agent_forwarding_off() {
    let dir = tempfile::tempdir().unwrap();
    let path = hosts_path(&dir);
    fs::write(&path, include_str!("fixtures/hosts-v7/hosts.json")).unwrap();
    let mut store = HostStore::open(&path).unwrap();
    let before = store.list().to_vec();
    assert!(before[1].identities_only);
    assert_eq!(before[1].default_directory.as_deref(), Some("/srv/build"));

    let mut draft = serde_json::to_value(&before[1]).unwrap();
    assert_eq!(draft["forwardAgent"], false);
    draft["forwardAgent"] = true.into();
    let edited = store
        .upsert(
            Some(before[1].id.clone()),
            serde_json::from_value(draft).unwrap(),
        )
        .unwrap();

    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["version"], 17);
    assert_eq!(saved["hosts"][0]["forwardAgent"], false);
    assert_eq!(saved["hosts"][1]["forwardAgent"], true);
    assert_eq!(saved["hosts"][1]["identitiesOnly"], true);
    assert_eq!(saved["hosts"][2]["forwardAgent"], false);
    assert_eq!(
        HostStore::open(path).unwrap().list(),
        &[before[0].clone(), edited, before[2].clone()]
    );
}

#[test]
fn settings_saved_by_v0_1_0_load_after_upgrading() {
    let dir = config_dir_from("v0.1.0");
    let store = SettingsStore::open(settings_path(&dir)).unwrap();

    // Sections only the front end reads come back exactly as saved.
    let sections = store.sections();
    assert_eq!(sections["appearance"], json!({ "theme": "dark" }));
    assert_eq!(sections["general"], json!({ "language": "zh" }));
    assert_eq!(sections["files"], json!({ "showHidden": true }));
    assert_eq!(sections["updates"], json!({ "checkOnStartup": false }));
    assert_eq!(sections["terminal"]["fontSize"], json!(14));
    // Sections the core reads too.
    assert_eq!(
        store
            .section::<ConnectionSettings>(ConnectionSettings::SECTION)
            .keepalive_interval(),
        Some(std::time::Duration::from_secs(60))
    );
    assert!(
        !store
            .section::<TerminalSettings>(TerminalSettings::SECTION)
            .shell_integration
    );
    assert_eq!(
        store
            .section::<TransferSettings>(TransferSettings::SECTION)
            .concurrency,
        5
    );
}

#[test]
fn saving_after_upgrading_from_v0_1_0_keeps_every_setting() {
    let dir = config_dir_from("v0.1.0");
    let before = SettingsStore::open(settings_path(&dir))
        .unwrap()
        .sections()
        .clone();
    let mut store = SettingsStore::open(settings_path(&dir)).unwrap();
    store
        .set("appearance", json!({ "theme": "light" }))
        .unwrap();

    let after = SettingsStore::open(settings_path(&dir)).unwrap();
    for (section, value) in &before {
        if section != "appearance" {
            assert_eq!(&after.sections()[section], value, "section {section}");
        }
    }
    assert_eq!(after.sections()["appearance"], json!({ "theme": "light" }));
}

#[test]
fn version_11_hosts_inherit_the_global_proxy_and_keep_their_terminal_options() {
    use sshastra_core::proxy::HostProxy;

    let dir = tempfile::tempdir().unwrap();
    let path = hosts_path(&dir);
    fs::write(&path, include_str!("fixtures/hosts-v11/hosts.json")).unwrap();
    let mut store = HostStore::open(&path).unwrap();
    let before = store.list().to_vec();
    assert!(before.iter().all(|host| host.proxy == HostProxy::Inherit));

    let mut draft = serde_json::to_value(&before[1]).unwrap();
    assert_eq!(draft["terminalCharset"], "gbk");
    assert_eq!(draft["terminalBackspace"], "ctrlH");
    draft["proxy"] = serde_json::json!({"mode":"direct"});
    let edited = store
        .upsert(
            Some(before[1].id.clone()),
            serde_json::from_value(draft).unwrap(),
        )
        .unwrap();

    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["version"], 17);
    assert_eq!(saved["hosts"][1]["proxy"]["mode"], "direct");
    assert!(saved["hosts"][0].get("proxy").is_none());
    assert_eq!(
        HostStore::open(path).unwrap().list(),
        &[before[0].clone(), edited, before[2].clone()]
    );
}

#[test]
fn version_12_hosts_keep_their_outbound_proxy_choices() {
    use sshastra_core::proxy::{HostProxy, ProxyConfig, ProxyKind};

    let dir = tempfile::tempdir().unwrap();
    let path = hosts_path(&dir);
    fs::write(&path, include_str!("fixtures/hosts-v12/hosts.json")).unwrap();
    let mut store = HostStore::open(&path).unwrap();

    let before = store.list().to_vec();
    assert_eq!(
        before[0].proxy,
        HostProxy::Override(ProxyConfig {
            kind: ProxyKind::Socks5,
            address: "relay.example.net".into(),
            port: 1080,
            username: Some("relay".into()),
        })
    );
    assert_eq!(before[1].proxy, HostProxy::Direct);
    assert_eq!(before[2].proxy, HostProxy::Inherit);

    let mut draft = serde_json::to_value(&before[2]).unwrap();
    draft["proxy"] = json!({"mode":"proxyCommand", "config":"nc %h %p"});
    let edited = store
        .upsert(
            Some(before[2].id.clone()),
            serde_json::from_value(draft).unwrap(),
        )
        .unwrap();

    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["version"], 17);
    assert_eq!(edited.proxy, HostProxy::ProxyCommand("nc %h %p".into()));
    assert_eq!(
        HostStore::open(&path).unwrap().list(),
        &[before[0].clone(), before[1].clone(), edited]
    );
}

#[test]
fn version_13_hosts_start_without_tags_and_keep_their_proxy_command() {
    use sshastra_core::proxy::HostProxy;

    let dir = tempfile::tempdir().unwrap();
    let path = hosts_path(&dir);
    fs::write(&path, include_str!("fixtures/hosts-v13/hosts.json")).unwrap();
    let mut store = HostStore::open(&path).unwrap();

    let mut expected = store.list()[0].clone();
    assert!(expected.tags.is_empty());
    assert_eq!(expected.proxy, HostProxy::ProxyCommand("nc %h %p".into()));

    let mut draft = serde_json::to_value(&expected).unwrap();
    draft["tags"] = json!(["Production"]);
    store
        .upsert(
            Some(expected.id.clone()),
            serde_json::from_value(draft).unwrap(),
        )
        .unwrap();
    expected.tags = vec!["Production".into()];
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["version"], 17);
    assert_eq!(saved["hosts"][0]["tags"], json!(["Production"]));
    assert_eq!(HostStore::open(path).unwrap().list(), &[expected]);
}

#[test]
fn version_14_hosts_keep_their_tags_and_can_set_and_clear_an_icon() {
    let dir = tempfile::tempdir().unwrap();
    let path = hosts_path(&dir);
    fs::write(&path, include_str!("fixtures/hosts-v14/hosts.json")).unwrap();
    let mut store = HostStore::open(&path).unwrap();

    let original = serde_json::to_value(&store.list()[0]).unwrap();
    assert!(original.get("icon").is_none());
    assert_eq!(original["tags"], json!(["Production", "East Coast"]));
    assert_eq!(original["groupId"], "g-prod");

    let mut selected = original.clone();
    selected["icon"] = json!("ubuntu");
    store
        .upsert(
            Some(id("h-gateway")),
            serde_json::from_value(selected.clone()).unwrap(),
        )
        .unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["version"], 17);
    assert_eq!(saved["hosts"][0], selected);
    let mut reopened = HostStore::open(&path).unwrap();
    assert_eq!(serde_json::to_value(&reopened.list()[0]).unwrap(), selected);

    reopened
        .upsert(
            Some(id("h-gateway")),
            serde_json::from_value(original.clone()).unwrap(),
        )
        .unwrap();
    let cleared = HostStore::open(path).unwrap();
    assert_eq!(serde_json::to_value(&cleared.list()[0]).unwrap(), original);
}

#[test]
fn version_15_hosts_keep_their_icons_and_can_set_and_clear_a_colour() {
    let dir = tempfile::tempdir().unwrap();
    let path = hosts_path(&dir);
    let fixture = include_str!("fixtures/hosts-v15/hosts.json");
    fs::write(&path, fixture).unwrap();
    let mut store = HostStore::open(&path).unwrap();

    let mut expected: serde_json::Value = serde_json::from_str(fixture).unwrap();
    expected.as_object_mut().unwrap().remove("version");
    assert_eq!(serde_json::to_value(store.tree()).unwrap(), expected);

    let original = expected["hosts"][1].clone();
    expected["hosts"][1]["color"] = json!("cyan");
    store
        .upsert(
            Some(id("h-web")),
            serde_json::from_value(expected["hosts"][1].clone()).unwrap(),
        )
        .unwrap();

    let mut saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        saved.as_object_mut().unwrap().remove("version"),
        Some(json!(17))
    );
    assert_eq!(saved, expected);
    let mut reopened = HostStore::open(&path).unwrap();
    assert_eq!(serde_json::to_value(reopened.tree()).unwrap(), expected);

    reopened
        .upsert(
            Some(id("h-web")),
            serde_json::from_value(original.clone()).unwrap(),
        )
        .unwrap();
    expected["hosts"][1] = original;
    assert_eq!(
        serde_json::to_value(HostStore::open(path).unwrap().tree()).unwrap(),
        expected
    );
}

#[test]
fn version_16_hosts_keep_their_icons_and_colours_before_detection() {
    use sshastra_core::hosts::DetectedOs;

    let dir = tempfile::tempdir().unwrap();
    let path = hosts_path(&dir);
    let fixture = include_str!("fixtures/hosts-v16/hosts.json");
    fs::write(&path, fixture).unwrap();
    let mut store = HostStore::open(&path).unwrap();

    let mut expected: serde_json::Value = serde_json::from_str(fixture).unwrap();
    expected.as_object_mut().unwrap().remove("version");
    assert_eq!(serde_json::to_value(store.tree()).unwrap(), expected);

    let web = id("h-web");
    assert!(store.begin_os_detection(&web, true));
    assert!(store
        .finish_os_detection(&web, DetectedOs::Unknown)
        .unwrap());
    expected["hosts"][1]["detectedOs"] = json!("unknown");

    let mut saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        saved.as_object_mut().unwrap().remove("version"),
        Some(json!(17))
    );
    assert_eq!(saved, expected);
    let mut reopened = HostStore::open(path).unwrap();
    assert_eq!(serde_json::to_value(reopened.tree()).unwrap(), expected);
    assert!(!reopened.begin_os_detection(&web, true));
}

#[test]
fn host_drafts_reject_icons_and_colours_outside_the_builtin_sets() {
    let draft = json!({
        "name": "Gateway",
        "address": "ssh.example.net",
        "port": 22,
        "user": "deploy",
        "auth": { "type": "auto" }
    });
    for (field, invalid) in [("icon", "custom"), ("color", "#ff8080")] {
        let mut invalid_draft = draft.clone();
        invalid_draft[field] = json!(invalid);
        assert!(serde_json::from_value::<HostDraft>(invalid_draft).is_err());
    }
}

#[test]
fn a_version_12_file_cannot_enable_a_proxy_command() {
    use sshastra_core::proxy::HostProxy;

    let dir = tempfile::tempdir().unwrap();
    let path = hosts_path(&dir);
    let mut legacy: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/hosts-v12/hosts.json")).unwrap();
    legacy["hosts"][2]["proxy"] = json!({"mode":"proxyCommand", "config":"nc %h %p"});
    fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();

    let store = HostStore::open(path).unwrap();
    assert_eq!(store.list()[2].proxy, HostProxy::Inherit);
}
