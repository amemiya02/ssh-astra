//! Exporting the Host list (Hosts, Groups, Port forwards) to a versioned file
//! and importing it, e.g. on another machine.

use std::collections::HashMap;
use std::path::PathBuf;

use sshastra_core::credentials::{CredentialKind, CredentialVault, MemoryVault};
use sshastra_core::forward::{ForwardDraft, ForwardKind};
use sshastra_core::hosts::{
    GroupId, HostAuth, HostDraft, HostId, HostStore, HostStoreError, HostTree,
};

fn store() -> (tempfile::TempDir, HostStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = HostStore::open(dir.path().join("hosts.json")).unwrap();
    (dir, store)
}

fn draft(name: &str) -> HostDraft {
    HostDraft {
        name: name.into(),
        address: format!("{name}.example.com"),
        port: 22,
        user: "deploy".into(),
        auth: HostAuth::Password,
        jump_host: None,
        terminal_scheme: None,
    }
}

fn local(bind_port: u16) -> ForwardDraft {
    ForwardDraft {
        label: "db".into(),
        kind: ForwardKind::Local {
            bind_address: "127.0.0.1".into(),
            bind_port,
            remote_host: "db.internal".into(),
            remote_port: 5432,
        },
    }
}

/// A library with nested Groups, a Jump host, a key file and a Port forward.
fn populated() -> (tempfile::TempDir, HostStore) {
    let (dir, mut store) = store();
    let prod = store.create_group("prod", None).unwrap();
    let eu = store.create_group("eu", Some(prod.id.clone())).unwrap();
    store.create_group("staging", None).unwrap();
    let bastion = store.upsert(None, draft("bastion")).unwrap();
    let web = store
        .upsert(
            None,
            HostDraft {
                jump_host: Some(bastion.id.clone()),
                auth: HostAuth::Key {
                    identity_file: PathBuf::from("~/.ssh/id_ed25519"),
                },
                terminal_scheme: Some("ember".into()),
                ..draft("web")
            },
        )
        .unwrap();
    store.upsert(None, draft("loose")).unwrap();
    store.save_forward(&web.id, None, local(15432)).unwrap();
    store.move_host(&bastion.id, Some(prod.id), 0).unwrap();
    store.move_host(&web.id, Some(eu.id), 0).unwrap();
    (dir, store)
}

/// `tree` with every id replaced by the one at the same position in `to`.
fn renamed(tree: &HostTree, to: &HostTree) -> HostTree {
    let groups: HashMap<GroupId, GroupId> = tree
        .groups
        .iter()
        .zip(&to.groups)
        .map(|(a, b)| (a.id.clone(), b.id.clone()))
        .collect();
    let hosts: HashMap<HostId, HostId> = tree
        .hosts
        .iter()
        .zip(&to.hosts)
        .map(|(a, b)| (a.id.clone(), b.id.clone()))
        .collect();
    let mut out = tree.clone();
    for g in &mut out.groups {
        g.id = groups[&g.id].clone();
        g.parent_id = g.parent_id.as_ref().map(|p| groups[p].clone());
    }
    for (h, target) in out.hosts.iter_mut().zip(&to.hosts) {
        h.id = hosts[&h.id].clone();
        h.group_id = h.group_id.as_ref().map(|g| groups[g].clone());
        h.jump_host = h.jump_host.as_ref().map(|j| hosts[j].clone());
        for (f, t) in h.forwards.iter_mut().zip(&target.forwards) {
            f.id = t.id.clone();
        }
    }
    out
}

#[test]
fn exporting_then_importing_into_an_empty_store_gives_the_same_host_list() {
    let (_a, source) = populated();
    let file = source.export();

    let (_b, mut target) = store();
    let summary = target.import(&file).unwrap();

    let imported = target.tree();
    assert_eq!(imported.hosts.len(), 3);
    assert_eq!(imported.groups.len(), 3);
    assert_eq!(renamed(&source.tree(), &imported), imported);
    assert_eq!(summary.hosts_added, 3);
    assert_eq!(summary.groups_added, 3);
    assert!(summary.skipped_hosts.is_empty());
}

#[test]
fn an_export_file_holds_no_credentials() {
    let (_dir, store) = populated();
    let vault = MemoryVault::default();
    for host in store.list() {
        vault
            .set(&host.id, CredentialKind::Password, "hunter2-password")
            .unwrap();
        vault
            .set(
                &host.id,
                CredentialKind::KeyPassphrase,
                "correct-horse-passphrase",
            )
            .unwrap();
    }

    let file = store.export();

    assert!(!file.contains("hunter2-password"), "{file}");
    assert!(!file.contains("correct-horse-passphrase"), "{file}");
    let lower = file.to_lowercase();
    for field in ["secret", "passphrase", "\"password\":"] {
        assert!(!lower.contains(field), "export has {field}: {file}");
    }
}

#[test]
fn importing_an_older_version_file_migrates_it() {
    // Version 1: no Groups, no Port forwards.
    let v1 = r#"{"version":1,"hosts":[
        {"id":"a","name":"bastion","address":"b.example.com","port":22,"user":"u","auth":{"type":"password"}},
        {"id":"b","name":"web","address":"w.example.com","port":2222,"user":"u","auth":{"type":"password"},"jumpHost":"a"}
    ]}"#;
    let (_dir, mut store) = store();

    store.import(v1).unwrap();

    let tree = store.tree();
    assert!(tree.groups.is_empty());
    let [bastion, web] = &tree.hosts[..] else {
        panic!("{tree:?}")
    };
    assert_eq!(web.port, 2222);
    assert_eq!(web.jump_host.as_ref(), Some(&bastion.id));
    assert!(web.forwards.is_empty());
    assert_eq!(web.group_id, None);
}

#[test]
fn importing_a_version_2_file_keeps_its_groups() {
    let v2 = r#"{"format":"sshastra-hosts","version":2,
        "groups":[{"id":"g","name":"prod","parentId":null}],
        "hosts":[{"id":"h","name":"web","address":"w","port":22,"user":"u","auth":{"type":"password"},"groupId":"g"}]}"#;
    let (_dir, mut store) = store();

    store.import(v2).unwrap();

    let tree = store.tree();
    assert_eq!(tree.groups[0].name, "prod");
    assert_eq!(tree.hosts[0].group_id.as_ref(), Some(&tree.groups[0].id));
}

#[test]
fn an_import_gives_everything_new_ids_and_keeps_references_pointing_at_the_copies() {
    let (_a, source) = populated();
    let (_b, mut target) = store();

    target.import(&source.export()).unwrap();

    let tree = target.tree();
    let original = source.tree();
    let original_forwards: Vec<_> = original.hosts.iter().flat_map(|h| &h.forwards).collect();
    for host in &tree.hosts {
        assert!(original.hosts.iter().all(|h| h.id != host.id));
        for forward in &host.forwards {
            assert!(original_forwards.iter().all(|f| f.id != forward.id));
        }
    }
    let web = tree.hosts.iter().find(|h| h.name == "web").unwrap();
    let bastion = tree.hosts.iter().find(|h| h.name == "bastion").unwrap();
    assert_eq!(web.jump_host.as_ref(), Some(&bastion.id));
    let eu = tree.groups.iter().find(|g| g.name == "eu").unwrap();
    assert_eq!(web.group_id.as_ref(), Some(&eu.id));
    assert_eq!(target.jump_chain(&web.id).unwrap().len(), 2);
}

#[test]
fn a_host_whose_name_is_taken_is_skipped_and_references_use_the_existing_one() {
    let (_a, source) = populated();
    let (_b, mut target) = store();
    let mine = target.upsert(None, draft("bastion")).unwrap();
    let prod = target.create_group("prod", None).unwrap();

    let summary = target.import(&source.export()).unwrap();

    assert_eq!(summary.skipped_hosts, vec!["bastion".to_string()]);
    assert_eq!(summary.hosts_added, 2);
    // "prod" is reused; "eu" (inside it) and "staging" are added.
    assert_eq!(summary.groups_added, 2);
    let tree = target.tree();
    assert_eq!(tree.hosts.iter().filter(|h| h.name == "bastion").count(), 1);
    let web = tree.hosts.iter().find(|h| h.name == "web").unwrap();
    assert_eq!(web.jump_host.as_ref(), Some(&mine.id));
    let eu = tree.groups.iter().find(|g| g.name == "eu").unwrap();
    assert_eq!(eu.parent_id.as_ref(), Some(&prod.id));
}

#[test]
fn importing_the_same_file_twice_adds_nothing_the_second_time() {
    let (_a, source) = populated();
    let file = source.export();
    let (_b, mut target) = store();
    target.import(&file).unwrap();

    let summary = target.import(&file).unwrap();

    assert_eq!(summary.hosts_added, 0);
    assert_eq!(summary.groups_added, 0);
    assert_eq!(target.tree().hosts.len(), 3);
    assert_eq!(target.tree().groups.len(), 3);
}

#[test]
fn an_import_survives_a_restart() {
    let (_a, source) = populated();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hosts.json");
    HostStore::open(&path)
        .unwrap()
        .import(&source.export())
        .unwrap();

    assert_eq!(HostStore::open(&path).unwrap().list().len(), 3);
}

#[test]
fn a_file_that_is_not_a_host_list_changes_nothing() {
    let (_dir, mut store) = populated();
    let before = store.tree();

    for bad in [
        "not json",
        r#"{"format":"something-else","version":3,"groups":[],"hosts":[]}"#,
        r#"{"format":"sshastra-hosts","version":999,"groups":[],"hosts":[]}"#,
    ] {
        assert!(store.import(bad).is_err(), "{bad}");
    }
    assert_eq!(store.tree(), before);
}

#[test]
fn an_import_whose_jump_hosts_loop_changes_nothing() {
    let looped = r#"{"version":3,"groups":[],"hosts":[
        {"id":"a","name":"a","address":"a","port":22,"user":"u","auth":{"type":"password"},"jumpHost":"b"},
        {"id":"b","name":"b","address":"b","port":22,"user":"u","auth":{"type":"password"},"jumpHost":"a"}
    ]}"#;
    let (_dir, mut store) = populated();
    let before = store.tree();

    assert!(matches!(
        store.import(looped),
        Err(HostStoreError::JumpHostCycle(_))
    ));
    assert_eq!(store.tree(), before);
}
