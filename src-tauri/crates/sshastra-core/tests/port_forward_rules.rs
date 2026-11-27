//! Port forward rules saved on a Host in the HostStore.

use std::fs;
use std::path::PathBuf;

use sshastra_core::forward::{ForwardDraft, ForwardKind};
use sshastra_core::hosts::{HostAuth, HostDraft, HostStore, HostStoreError};

fn store_path() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hosts.json");
    (dir, path)
}

fn draft(name: &str) -> HostDraft {
    HostDraft {
        name: name.into(),
        tags: Vec::new(),
        address: "10.0.0.5".into(),
        port: 22,
        user: "deploy".into(),
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
    }
}

fn local(bind_port: u16, remote_host: &str, remote_port: u16) -> ForwardDraft {
    ForwardDraft {
        label: String::new(),
        auto_start: false,
        kind: ForwardKind::Local {
            bind_address: "127.0.0.1".into(),
            bind_port,
            remote_host: remote_host.into(),
            remote_port,
        },
    }
}

#[test]
fn a_local_forward_saved_on_a_host_is_there_after_a_restart() {
    let (_dir, path) = store_path();
    let (host, rule) = {
        let mut store = HostStore::open(&path).unwrap();
        let host = store.upsert(None, draft("db")).unwrap();
        let rule = store
            .save_forward(
                &host.id,
                None,
                ForwardDraft {
                    label: "postgres".into(),
                    ..local(15432, "db.internal", 5432)
                },
            )
            .unwrap();
        (host, rule)
    };

    let reopened = HostStore::open(&path).unwrap();
    let forwards = &reopened.get(&host.id).unwrap().forwards;
    assert_eq!(forwards, std::slice::from_ref(&rule));
    assert_eq!(rule.label, "postgres");
    assert_eq!(
        rule.kind,
        ForwardKind::Local {
            bind_address: "127.0.0.1".into(),
            bind_port: 15432,
            remote_host: "db.internal".into(),
            remote_port: 5432,
        }
    );
}

#[test]
fn saving_with_an_id_edits_that_rule_and_deleting_removes_it() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let host = store.upsert(None, draft("db")).unwrap();
    let a = store
        .save_forward(&host.id, None, local(8080, "web", 80))
        .unwrap();
    let b = store
        .save_forward(&host.id, None, local(8443, "web", 443))
        .unwrap();

    let edited = store
        .save_forward(&host.id, Some(a.id.clone()), local(9090, "web", 8080))
        .unwrap();
    assert_eq!(edited.id, a.id);
    assert_eq!(store.get(&host.id).unwrap().forwards, [edited, b.clone()]);

    store.delete_forward(&host.id, &a.id).unwrap();
    assert_eq!(store.get(&host.id).unwrap().forwards, [b]);
}

#[test]
fn editing_the_host_keeps_its_forwards() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let host = store.upsert(None, draft("db")).unwrap();
    let rule = store
        .save_forward(&host.id, None, local(8080, "web", 80))
        .unwrap();

    let renamed = store.upsert(Some(host.id.clone()), draft("db2")).unwrap();

    assert_eq!(renamed.forwards, [rule]);
}

#[test]
fn a_duplicated_host_gets_copies_of_the_forwards_under_new_ids() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let host = store.upsert(None, draft("db")).unwrap();
    let rule = store
        .save_forward(&host.id, None, local(8080, "web", 80))
        .unwrap();

    let copy = store.duplicate_host(&host.id, "db copy").unwrap();

    assert_eq!(copy.forwards.len(), 1);
    assert_eq!(copy.forwards[0].kind, rule.kind);
    assert_ne!(copy.forwards[0].id, rule.id);
}

#[test]
fn a_rule_needs_a_local_port_a_remote_host_and_a_remote_port() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let host = store.upsert(None, draft("db")).unwrap();

    for (bad, field) in [
        (local(0, "web", 80), "bindPort"),
        (local(8080, "  ", 80), "remoteHost"),
        (local(8080, "web", 0), "remotePort"),
    ] {
        match store.save_forward(&host.id, None, bad) {
            Err(HostStoreError::Invalid(f)) => assert_eq!(f, field),
            other => panic!("expected Invalid({field}), got {other:?}"),
        }
    }
    assert!(store.get(&host.id).unwrap().forwards.is_empty());
}

#[test]
fn a_blank_bind_address_means_loopback_only() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let host = store.upsert(None, draft("db")).unwrap();
    let mut rule = local(8080, " web ", 80);
    let ForwardKind::Local { bind_address, .. } = &mut rule.kind else {
        unreachable!()
    };
    *bind_address = " ".into();

    let saved = store.save_forward(&host.id, None, rule).unwrap();

    assert_eq!(
        saved.kind,
        ForwardKind::Local {
            bind_address: "127.0.0.1".into(),
            bind_port: 8080,
            remote_host: "web".into(),
            remote_port: 80,
        }
    );
}

#[test]
fn forwards_on_an_unknown_host_or_rule_are_not_found() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let host = store.upsert(None, draft("db")).unwrap();
    let other = store.upsert(None, draft("web")).unwrap();
    let rule = store
        .save_forward(&host.id, None, local(8080, "web", 80))
        .unwrap();

    assert!(matches!(
        store.delete_forward(&other.id, &rule.id),
        Err(HostStoreError::ForwardNotFound(_))
    ));
    assert!(matches!(
        store.save_forward(&other.id, Some(rule.id.clone()), local(1, "a", 1)),
        Err(HostStoreError::ForwardNotFound(_))
    ));
}

#[test]
fn hosts_saved_before_port_forwards_existed_have_none() {
    let (_dir, path) = store_path();
    fs::write(
        &path,
        r#"{"version":2,"groups":[],"hosts":[{"id":"h1","name":"old","address":"a","port":22,"user":"u","auth":{"type":"password"},"jumpHost":null,"groupId":null}]}"#,
    )
    .unwrap();

    let mut store = HostStore::open(&path).unwrap();
    assert!(store.list()[0].forwards.is_empty());

    // The next save writes the current format.
    store.upsert(None, draft("new")).unwrap();
    let json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(json["version"], 14);
    assert_eq!(json["hosts"][0]["forwards"], serde_json::json!([]));
}

#[test]
fn the_rule_is_stored_flat_with_its_type() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let host = store.upsert(None, draft("db")).unwrap();
    store
        .save_forward(&host.id, None, local(8080, "web", 80))
        .unwrap();

    let json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let rule = &json["hosts"][0]["forwards"][0];
    assert_eq!(rule["type"], "local");
    assert_eq!(rule["bindAddress"], "127.0.0.1");
    assert_eq!(rule["bindPort"], 8080);
    assert_eq!(rule["remoteHost"], "web");
    assert_eq!(rule["remotePort"], 80);
    assert!(rule["id"].is_string());
}

fn remote(bind_port: u16, local_host: &str, local_port: u16) -> ForwardDraft {
    ForwardDraft {
        label: String::new(),
        auto_start: false,
        kind: ForwardKind::Remote {
            bind_address: String::new(),
            bind_port,
            local_host: local_host.into(),
            local_port,
        },
    }
}

fn dynamic(bind_port: u16) -> ForwardDraft {
    ForwardDraft {
        label: String::new(),
        auto_start: false,
        kind: ForwardKind::Dynamic {
            bind_address: String::new(),
            bind_port,
        },
    }
}

/// The saved file's first rule on the first Host, as JSON.
fn stored_rule(path: &std::path::Path) -> serde_json::Value {
    let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    json["hosts"][0]["forwards"][0].clone()
}

#[test]
fn a_remote_rule_is_stored_flat_and_listens_on_the_servers_loopback_by_default() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let host = store.upsert(None, draft("db")).unwrap();

    let saved = store
        .save_forward(&host.id, None, remote(9000, " 127.0.0.1 ", 3000))
        .unwrap();

    assert_eq!(
        saved.kind,
        ForwardKind::Remote {
            bind_address: "localhost".into(),
            bind_port: 9000,
            local_host: "127.0.0.1".into(),
            local_port: 3000,
        }
    );
    let rule = stored_rule(&path);
    assert_eq!(rule["type"], "remote");
    assert_eq!(rule["bindAddress"], "localhost");
    assert_eq!(rule["bindPort"], 9000);
    assert_eq!(rule["localHost"], "127.0.0.1");
    assert_eq!(rule["localPort"], 3000);
    assert_eq!(rule["autoStart"], false);
}

#[test]
fn a_dynamic_rule_is_stored_flat_and_listens_on_loopback_by_default() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let host = store.upsert(None, draft("db")).unwrap();

    let saved = store.save_forward(&host.id, None, dynamic(1080)).unwrap();

    assert_eq!(
        saved.kind,
        ForwardKind::Dynamic {
            bind_address: "127.0.0.1".into(),
            bind_port: 1080,
        }
    );
    let rule = stored_rule(&path);
    assert_eq!(rule["type"], "dynamic");
    assert_eq!(rule["bindAddress"], "127.0.0.1");
    assert_eq!(rule["bindPort"], 1080);
}

#[test]
fn remote_and_dynamic_rules_name_their_invalid_field() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let host = store.upsert(None, draft("db")).unwrap();

    for (bad, field) in [
        (remote(0, "127.0.0.1", 80), "bindPort"),
        (remote(9000, " ", 80), "localHost"),
        (remote(9000, "127.0.0.1", 0), "localPort"),
        (dynamic(0), "bindPort"),
    ] {
        match store.save_forward(&host.id, None, bad) {
            Err(HostStoreError::Invalid(f)) => assert_eq!(f, field),
            other => panic!("expected Invalid({field}), got {other:?}"),
        }
    }
}

#[test]
fn auto_start_is_saved_with_the_rule() {
    let (_dir, path) = store_path();
    let rule = {
        let mut store = HostStore::open(&path).unwrap();
        let host = store.upsert(None, draft("db")).unwrap();
        store
            .save_forward(
                &host.id,
                None,
                ForwardDraft {
                    auto_start: true,
                    ..dynamic(1080)
                },
            )
            .unwrap()
    };

    assert!(rule.auto_start);
    let reopened = HostStore::open(&path).unwrap();
    assert!(reopened.list()[0].forwards[0].auto_start);
    assert_eq!(stored_rule(&path)["autoStart"], true);
}

#[test]
fn rules_saved_before_auto_start_existed_do_not_auto_start() {
    let (_dir, path) = store_path();
    fs::write(
        &path,
        r#"{"version":3,"groups":[],"hosts":[{"id":"h1","name":"old","address":"a","port":22,"user":"u","auth":{"type":"password"},"jumpHost":null,"groupId":null,"forwards":[{"id":"f1","label":"","type":"local","bindAddress":"127.0.0.1","bindPort":8080,"remoteHost":"web","remotePort":80}]}]}"#,
    )
    .unwrap();

    let mut store = HostStore::open(&path).unwrap();
    assert!(!store.list()[0].forwards[0].auto_start);

    store.upsert(None, draft("new")).unwrap();
    let json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(json["version"], 14);
    assert_eq!(json["hosts"][0]["forwards"][0]["autoStart"], false);
}
