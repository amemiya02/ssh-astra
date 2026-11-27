//! HostStore: saved Hosts in a versioned JSON file that survives restarts.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use sshastra_core::hosts::{
    Bookmark, GroupId, Host, HostAuth, HostDraft, HostId, HostStore, HostStoreError, HostTagChange,
};

fn draft(name: &str) -> HostDraft {
    HostDraft {
        name: name.into(),
        tags: Vec::new(),
        icon: None,
        color: None,
        address: "10.0.0.5".into(),
        port: 2222,
        user: "deploy".into(),
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
    }
}

fn via(name: &str, jump: &Host) -> HostDraft {
    HostDraft {
        jump_host: Some(jump.id.clone()),
        ..draft(name)
    }
}

#[test]
fn bookmark_edits_survive_restart_host_edits_and_duplication() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let host = store.upsert(None, draft("web")).unwrap();
    let folder = "/srv/work 臨時 ";
    assert_eq!(store.add_bookmark(&host.id, folder).unwrap().path, folder);
    store.rename_bookmark(&host.id, folder, "  Work  ").unwrap();
    store.add_bookmark(&host.id, "/elsewhere").unwrap();
    store.add_bookmark(&host.id, folder).unwrap();
    store.delete_bookmark(&host.id, "/elsewhere").unwrap();
    store
        .upsert(Some(host.id.clone()), draft("new name"))
        .unwrap();
    let copy = store.duplicate_host(&host.id, "copy").unwrap();

    let mut reopened = HostStore::open(&path).unwrap();
    let expected = [Bookmark {
        path: folder.into(),
        name: Some("Work".into()),
    }];
    assert_eq!(reopened.get(&host.id).unwrap().name, "new name");
    assert_eq!(reopened.get(&host.id).unwrap().bookmarks, expected);
    assert_eq!(reopened.get(&copy.id).unwrap().bookmarks, expected);

    reopened.rename_bookmark(&copy.id, folder, "  ").unwrap();
    reopened.delete_bookmark(&host.id, folder).unwrap();
    let reopened = HostStore::open(&path).unwrap();
    assert!(reopened.get(&host.id).unwrap().bookmarks.is_empty());
    assert_eq!(
        reopened.get(&copy.id).unwrap().bookmarks,
        [Bookmark {
            path: folder.into(),
            name: None
        }]
    );
}

#[test]
fn saving_and_editing_a_host_keeps_at_most_ten_normalized_tags() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let host = store.upsert(None, draft("web")).unwrap();
    let long_tag = "界".repeat(32);
    let mut tags = vec![
        "  Production  ".into(),
        "PRODUCTION".into(),
        "\t".into(),
        format!("{long_tag}字"),
        long_tag.clone(),
        "  Äpfel ".into(),
        "äPFEL".into(),
    ];
    tags.extend((4..=12).map(|n| format!("Tag {n}")));
    let saved = store
        .upsert(
            Some(host.id.clone()),
            HostDraft {
                tags,
                ..draft("web")
            },
        )
        .unwrap();

    let expected = [
        "Production",
        &long_tag,
        "Äpfel",
        "Tag 4",
        "Tag 5",
        "Tag 6",
        "Tag 7",
        "Tag 8",
        "Tag 9",
        "Tag 10",
    ];
    assert_eq!(saved.tags, expected);
    assert_eq!(HostStore::open(&path).unwrap().list()[0].tags, expected);

    store.upsert(Some(host.id), draft("web")).unwrap();
    assert!(HostStore::open(&path).unwrap().list()[0].tags.is_empty());
}

#[test]
fn a_hosts_own_terminal_colour_scheme_is_kept_across_restarts() {
    let (_dir, path) = store_path();
    let prod = HostStore::open(&path)
        .unwrap()
        .upsert(
            None,
            HostDraft {
                terminal_scheme: Some("ember".into()),
                default_directory: None,
                ..draft("prod")
            },
        )
        .unwrap();

    let reopened = HostStore::open(&path).unwrap();
    assert_eq!(
        reopened.get(&prod.id).unwrap().terminal_scheme.as_deref(),
        Some("ember")
    );
}

#[test]
fn a_hosts_default_directory_is_kept_across_restarts_and_blank_means_home() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let web = store
        .upsert(
            None,
            HostDraft {
                default_directory: Some("  /srv/www ".into()),
                ..draft("web")
            },
        )
        .unwrap();
    let db = store
        .upsert(
            None,
            HostDraft {
                default_directory: Some("   ".into()),
                ..draft("db")
            },
        )
        .unwrap();

    let reopened = HostStore::open(&path).unwrap();
    assert_eq!(
        reopened.get(&web.id).unwrap().default_directory.as_deref(),
        Some("/srv/www")
    );
    assert_eq!(reopened.get(&db.id).unwrap().default_directory, None);
}

#[test]
fn a_version_4_file_is_migrated_with_no_default_directories() {
    let (_dir, path) = store_path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"{"version":4,"groups":[],"hosts":[{"id":"h1","name":"old","address":"a","port":22,"user":"u","auth":{"type":"password"},"jumpHost":null,"groupId":null,"forwards":[]}]}"#,
    )
    .unwrap();

    let mut store = HostStore::open(&path).unwrap();
    assert_eq!(store.list()[0].default_directory, None);
    store.upsert(None, draft("new")).unwrap();
    let json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(json["version"], 23);
}

#[test]
fn hosts_saved_before_terminal_schemes_existed_follow_the_global_scheme() {
    let (_dir, path) = store_path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"{"version":1,"hosts":[{"id":"h1","name":"old","address":"a","port":22,"user":"u","auth":{"type":"password"}}]}"#,
    )
    .unwrap();

    let store = HostStore::open(&path).unwrap();
    assert_eq!(store.list()[0].terminal_scheme, None);
}

#[test]
fn a_blank_terminal_scheme_means_none() {
    let (_dir, path) = store_path();
    let host = HostStore::open(&path)
        .unwrap()
        .upsert(
            None,
            HostDraft {
                terminal_scheme: Some("  ".into()),
                default_directory: None,
                ..draft("x")
            },
        )
        .unwrap();
    assert_eq!(host.terminal_scheme, None);
    let json = fs::read_to_string(&path).unwrap();
    assert!(!json.contains("terminalScheme"), "{json}");
}

fn store_path() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config").join("hosts.json");
    (dir, path)
}

#[test]
fn starts_empty_when_there_is_no_file_yet() {
    let (_dir, path) = store_path();
    let store = HostStore::open(&path).unwrap();
    assert!(store.list().is_empty());
}

#[test]
fn creates_a_host_with_the_requested_id_and_rejects_reusing_it() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let id = HostId::from("quick-connect-id".to_owned());

    let saved = store.insert(id.clone(), draft("lab")).unwrap();
    assert_eq!(saved.id, id);
    assert!(matches!(
        store.insert(id.clone(), draft("replacement")),
        Err(HostStoreError::DuplicateId(duplicate)) if duplicate == id
    ));

    let reopened = HostStore::open(&path).unwrap();
    assert_eq!(store.list(), std::slice::from_ref(&saved));
    assert_eq!(reopened.list(), &[saved]);
}

#[test]
fn saved_hosts_are_there_after_a_restart() {
    let (_dir, path) = store_path();
    let (web, db) = {
        let mut store = HostStore::open(&path).unwrap();
        let web = store.upsert(None, draft("web")).unwrap();
        let db = store.upsert(None, draft("db")).unwrap();
        (web, db)
    };

    let reopened = HostStore::open(&path).unwrap();

    assert_eq!(reopened.list(), [web.clone(), db.clone()]);
    assert_eq!(reopened.get(&db.id), Some(&db));
    assert_eq!(web.name, "web");
    assert_eq!(
        (web.address.as_str(), web.port, web.user.as_str()),
        ("10.0.0.5", 2222, "deploy")
    );
    assert_ne!(web.id, db.id);
}

#[test]
fn upsert_with_an_id_edits_that_host_in_place() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let a = store.upsert(None, draft("a")).unwrap();
    let b = store.upsert(None, draft("b")).unwrap();

    let renamed = store
        .upsert(
            Some(a.id.clone()),
            HostDraft {
                name: "a2".into(),
                ..draft("a")
            },
        )
        .unwrap();

    assert_eq!(renamed.id, a.id);
    let names: Vec<_> = HostStore::open(&path)
        .unwrap()
        .list()
        .iter()
        .map(|h| h.name.clone())
        .collect();
    assert_eq!(names, ["a2", "b"]);
    assert!(store.get(&b.id).is_some());
}

#[test]
fn upsert_with_an_unknown_id_is_an_error() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let a = store.upsert(None, draft("a")).unwrap();
    store.delete(&a.id).unwrap();
    assert!(matches!(
        store.upsert(Some(a.id), draft("a")),
        Err(HostStoreError::NotFound(_))
    ));
}

#[test]
fn delete_removes_the_host_for_good() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let a = store.upsert(None, draft("a")).unwrap();
    let b = store.upsert(None, draft("b")).unwrap();

    store.delete(&a.id).unwrap();

    assert_eq!(HostStore::open(&path).unwrap().list(), [b]);
    assert!(matches!(
        store.delete(&a.id),
        Err(HostStoreError::NotFound(_))
    ));
}

#[test]
fn incomplete_hosts_are_rejected_and_not_saved() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    for bad in [
        HostDraft {
            name: "  ".into(),
            ..draft("x")
        },
        HostDraft {
            address: "".into(),
            ..draft("x")
        },
        HostDraft {
            user: "".into(),
            ..draft("x")
        },
        HostDraft {
            port: 0,
            ..draft("x")
        },
    ] {
        assert!(matches!(
            store.upsert(None, bad),
            Err(HostStoreError::Invalid(_))
        ));
    }
    assert!(HostStore::open(&path).unwrap().list().is_empty());
}

#[test]
fn the_file_is_versioned_json() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    store.upsert(None, draft("web")).unwrap();

    let json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(json["version"], 23);
    assert_eq!(json["hosts"][0]["name"], "web");
    assert_eq!(json["hosts"][0]["auth"]["type"], "password");
}

#[test]
fn a_key_host_keeps_its_key_file_path_but_never_the_key() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let mut with_key = draft("web");
    with_key.auth = HostAuth::Key {
        identity_file: " ~/.ssh/id_ed25519 ".into(),
    };
    let saved = store.upsert(None, with_key).unwrap();

    assert_eq!(
        saved.auth,
        HostAuth::Key {
            identity_file: "~/.ssh/id_ed25519".into()
        }
    );
    let json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        json["hosts"][0]["auth"],
        serde_json::json!({ "type": "key", "identityFile": "~/.ssh/id_ed25519" })
    );
    assert_eq!(HostStore::open(&path).unwrap().list(), [saved]);
}

#[test]
fn a_key_host_needs_a_key_file() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let mut without = draft("web");
    without.auth = HostAuth::Key {
        identity_file: "  ".into(),
    };
    assert!(matches!(
        store.upsert(None, without),
        Err(HostStoreError::Invalid("identityFile"))
    ));
}

#[test]
fn a_corrupt_file_is_reported_and_left_untouched() {
    let (_dir, path) = store_path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "{ not json").unwrap();

    assert!(matches!(
        HostStore::open(&path),
        Err(HostStoreError::Corrupt(_))
    ));
    assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
}

#[test]
fn a_file_from_a_newer_version_is_refused_rather_than_overwritten() {
    let (_dir, path) = store_path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, r#"{"version": 99, "hosts": []}"#).unwrap();

    assert!(matches!(
        HostStore::open(&path),
        Err(HostStoreError::UnsupportedVersion(99))
    ));
}

#[test]
fn readers_never_see_a_half_written_file() {
    let (dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    // Big enough that a non-atomic write would be observable mid-way.
    let long_name = "x".repeat(64 * 1024);
    store.upsert(None, draft(&long_name)).unwrap();

    let done = Arc::new(AtomicBool::new(false));
    let reader = {
        let (done, path) = (done.clone(), path.clone());
        thread::spawn(move || {
            let mut reads = 0;
            while !done.load(Ordering::Relaxed) {
                let text = fs::read_to_string(&path).unwrap();
                serde_json::from_str::<serde_json::Value>(&text)
                    .unwrap_or_else(|e| panic!("partial file after {reads} reads: {e}"));
                reads += 1;
            }
        })
    };
    for i in 0..30 {
        store
            .upsert(None, draft(&format!("{long_name}{i}")))
            .unwrap();
    }
    done.store(true, Ordering::Relaxed);
    reader.join().unwrap();

    // Only the store file remains: no temporary files left behind.
    let entries: Vec<_> = fs::read_dir(path.parent().unwrap()).unwrap().collect();
    assert_eq!(entries.len(), 1, "unexpected files in {:?}", dir.path());
}

#[test]
fn a_host_reaches_its_target_through_its_chain_of_jump_hosts() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let outer = store.upsert(None, draft("outer")).unwrap();
    let inner = store.upsert(None, via("inner", &outer)).unwrap();
    let target = store.upsert(None, via("target", &inner)).unwrap();

    let reopened = HostStore::open(&path).unwrap();

    assert_eq!(
        reopened.get(&target.id).unwrap().jump_host,
        Some(inner.id.clone())
    );
    assert_eq!(
        reopened.jump_chain(&target.id).unwrap(),
        [outer.clone(), inner, target]
    );
    assert_eq!(reopened.jump_chain(&outer.id).unwrap(), [outer]);
}

#[test]
fn a_jump_host_cycle_is_refused_when_saving() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let a = store.upsert(None, draft("a")).unwrap();
    let b = store.upsert(None, via("b", &a)).unwrap();
    let c = store.upsert(None, via("c", &b)).unwrap();

    let result = store.upsert(Some(a.id.clone()), via("a", &c));
    match result {
        Err(HostStoreError::JumpHostCycle(names)) => assert_eq!(names, ["a", "c", "b", "a"]),
        other => panic!("expected a cycle, got {other:?}"),
    }
    let result = store.upsert(Some(a.id.clone()), via("a", &a));
    assert!(
        matches!(result, Err(HostStoreError::JumpHostCycle(_))),
        "{result:?}"
    );

    assert_eq!(HostStore::open(&path).unwrap().list(), [a, b, c]);
}

#[test]
fn a_draft_cannot_test_a_jump_route_that_leads_back_to_its_edited_host() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let a = store.upsert(None, draft("a")).unwrap();
    let b = store.upsert(None, via("b", &a)).unwrap();

    let result = store.draft_jump_chain(Some(a.id.clone()), via("edited a", &b));
    match result {
        Err(HostStoreError::JumpHostCycle(names)) => {
            assert_eq!(names, ["edited a", "b", "edited a"])
        }
        other => panic!("expected a cycle, got {other:?}"),
    }
    assert_eq!(store.list(), [a, b]);
}

#[test]
fn a_missing_jump_host_is_refused_when_saving() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let gone = store.upsert(None, draft("gone")).unwrap();
    store.delete(&gone.id).unwrap();

    let result = store.upsert(None, via("x", &gone));

    assert!(
        matches!(result, Err(HostStoreError::NotFound(_))),
        "{result:?}"
    );
    assert!(store.list().is_empty());
}

#[test]
fn a_host_in_use_as_a_jump_host_cannot_be_deleted() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let jump = store.upsert(None, draft("bastion")).unwrap();
    let target = store.upsert(None, via("db", &jump)).unwrap();

    match store.delete(&jump.id) {
        Err(HostStoreError::InUseAsJumpHost { by }) => assert_eq!(by, "db"),
        other => panic!("expected in use, got {other:?}"),
    }

    store.delete(&target.id).unwrap();
    store.delete(&jump.id).unwrap();
}

#[test]
fn hosts_saved_before_jump_hosts_existed_still_load() {
    let (_dir, path) = store_path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"{"version": 1, "hosts": [{"id": "1", "name": "web", "address": "a", "port": 22,
            "user": "u", "auth": {"type": "password"}}]}"#,
    )
    .unwrap();

    let store = HostStore::open(&path).unwrap();

    assert_eq!(store.list()[0].jump_host, None);
}

#[test]
fn batch_move_appends_hosts_in_saved_order_and_keeps_the_whole_tree() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let group = store.create_group("work", None).unwrap();
    let a = store.upsert(None, draft("a")).unwrap().id;
    let b = store.upsert(None, draft("b")).unwrap().id;
    let c = store.upsert(None, draft("c")).unwrap().id;
    let d = store.upsert(None, draft("d")).unwrap().id;
    store.move_host(&c, Some(group.id.clone()), 0).unwrap();
    let before = fs::read(&path).unwrap();

    let missing = HostId::from("missing".to_owned());
    assert!(store
        .move_hosts(&[a.clone(), missing], Some(group.id.clone()))
        .is_err());
    let missing_group = GroupId::from("missing".to_owned());
    assert!(store
        .move_hosts(&[a.clone(), b.clone()], Some(missing_group))
        .is_err());
    assert_eq!(fs::read(&path).unwrap(), before);

    let tree = store
        .move_hosts(&[b.clone(), a.clone(), a.clone()], Some(group.id.clone()))
        .unwrap();
    assert_eq!(tree, HostStore::open(&path).unwrap().tree());
    assert_eq!(tree.groups.as_slice(), std::slice::from_ref(&group));
    let under_group: Vec<_> = tree
        .hosts
        .iter()
        .filter(|h| h.group_id.as_ref() == Some(&group.id))
        .map(|h| h.id.clone())
        .collect();
    assert_eq!(under_group, [c, a, b]);
    assert_eq!(
        tree.hosts.iter().find(|h| h.id == d).unwrap().group_id,
        None
    );
}

#[test]
fn batch_tag_changes_normalize_and_reject_the_entire_change_if_any_host_is_full() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    store.create_group("work", None).unwrap();
    let a = store.upsert(None, draft("a")).unwrap().id;
    let b = store
        .upsert(
            None,
            HostDraft {
                tags: (0..10).map(|i| format!("tag-{i}")).collect(),
                ..draft("b")
            },
        )
        .unwrap()
        .id;
    let before = store.tree();
    let bytes = fs::read(&path).unwrap();
    let ids = [a.clone(), b.clone()];

    assert!(matches!(
        store.edit_host_tags(&ids, HostTagChange::Add, "on-call"),
        Err(HostStoreError::TagLimit { .. })
    ));
    assert_eq!(store.tree(), before);
    assert_eq!(fs::read(&path).unwrap(), bytes);

    let tree = store
        .edit_host_tags(&ids, HostTagChange::Add, " TaG-0 ")
        .unwrap();
    assert_eq!(tree, HostStore::open(&path).unwrap().tree());
    assert_eq!(tree.groups, before.groups);
    assert_eq!(store.get(&a).unwrap().tags, ["TaG-0"]);
    assert_eq!(store.get(&b).unwrap().tags.len(), 10);
    let tree = store
        .edit_host_tags(&ids, HostTagChange::Remove, " TAG-0 ")
        .unwrap();
    assert_eq!(tree, HostStore::open(&path).unwrap().tree());
    assert_eq!(tree.groups, before.groups);
    assert!(store.get(&a).unwrap().tags.is_empty());
    assert_eq!(store.get(&b).unwrap().tags.len(), 9);
    assert_eq!(store.get(&b).unwrap().tags[0], "tag-1");
}

#[test]
fn batch_delete_allows_a_jump_host_with_its_dependents_and_rejects_partial_deletion() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let group = store.create_group("work", None).unwrap();
    let jump = store.upsert(None, draft("jump")).unwrap().id;
    let web = store
        .upsert(
            None,
            HostDraft {
                jump_host: Some(jump.clone()),
                ..draft("web")
            },
        )
        .unwrap()
        .id;
    let unrelated = store.upsert(None, draft("unrelated")).unwrap().id;
    let before = store.tree();
    let bytes = fs::read(&path).unwrap();

    assert!(
        matches!(store.delete_hosts(&[unrelated.clone(), jump.clone()]), Err(HostStoreError::InUseAsJumpHost { by }) if by == "web")
    );
    let missing = HostId::from("missing".to_owned());
    assert!(store.delete_hosts(&[web.clone(), missing]).is_err());
    assert_eq!(store.tree(), before);
    assert_eq!(fs::read(&path).unwrap(), bytes);

    let tree = store.delete_hosts(&[jump, web]).unwrap();
    assert_eq!(tree, HostStore::open(&path).unwrap().tree());
    assert_eq!(tree.groups, [group]);
    assert_eq!(tree.hosts, [store.get(&unrelated).unwrap().clone()]);
}

#[test]
fn unsuccessful_batch_writes_leave_the_saved_tree_and_memory_unchanged() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let group = store.create_group("work", None).unwrap();
    let a = store.upsert(None, draft("a")).unwrap().id;
    let b = store.upsert(None, draft("b")).unwrap().id;
    let ids = [a, b];
    let before = store.tree();
    let bytes = fs::read(&path).unwrap();
    let backup = path.with_extension("previous");
    fs::rename(&path, &backup).unwrap();
    fs::create_dir(&path).unwrap();

    let results = [
        store.move_hosts(&ids, Some(group.id)),
        store.edit_host_tags(&ids, HostTagChange::Add, "on-call"),
        store.delete_hosts(&ids),
    ];
    for result in results {
        assert!(matches!(result, Err(HostStoreError::Io { .. })));
    }
    assert_eq!(store.tree(), before);
    assert_eq!(fs::read(&backup).unwrap(), bytes);
}
