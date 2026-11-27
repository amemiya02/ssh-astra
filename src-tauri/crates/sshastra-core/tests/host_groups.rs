//! HostStore Groups, moving and ordering: the Host list's tree survives restarts.

use std::fs;
use std::path::PathBuf;

use sshastra_core::hosts::{GroupId, HostAuth, HostDraft, HostStore, HostStoreError};

fn draft(name: &str) -> HostDraft {
    HostDraft {
        name: name.into(),
        tags: Vec::new(),
        icon: None,
        color: None,
        address: "10.0.0.5".into(),
        port: 22,
        user: "deploy".into(),
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
    }
}

fn store_path() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hosts.json");
    (dir, path)
}

#[test]
fn groups_nest_and_survive_a_restart() {
    let (_dir, path) = store_path();
    let (prod, web) = {
        let mut store = HostStore::open(&path).unwrap();
        let prod = store.create_group("Production", None).unwrap();
        let web = store.create_group(" Web ", Some(prod.id.clone())).unwrap();
        (prod, web)
    };

    let reopened = HostStore::open(&path).unwrap();

    assert_eq!(reopened.groups(), [prod.clone(), web.clone()]);
    assert_eq!(web.name, "Web");
    assert_eq!(web.parent_id, Some(prod.id));
}

/// Names of the Hosts in `group`, in order.
fn names(store: &HostStore, group: Option<&GroupId>) -> Vec<String> {
    store
        .list()
        .iter()
        .filter(|h| h.group_id.as_ref() == group)
        .map(|h| h.name.clone())
        .collect()
}

#[test]
fn a_version_1_file_opens_with_every_host_at_the_top_level() {
    let (_dir, path) = store_path();
    fs::write(
        &path,
        r#"{"version": 1, "hosts": [{"id": "h1", "name": "web", "address": "10.0.0.5",
            "port": 22, "user": "deploy", "auth": {"type": "password"}}]}"#,
    )
    .unwrap();

    let mut store = HostStore::open(&path).unwrap();
    assert_eq!(names(&store, None), ["web"]);
    assert!(store.groups().is_empty());

    // The next save writes the current format.
    store.create_group("Prod", None).unwrap();
    let json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(json["version"], 19);
    assert_eq!(json["hosts"][0]["name"], "web");
}

#[test]
fn a_host_moves_into_a_group_at_a_position_and_stays_there() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let prod = store.create_group("Prod", None).unwrap();
    let a = store.upsert(None, draft("a")).unwrap();
    let b = store.upsert(None, draft("b")).unwrap();
    let c = store.upsert(None, draft("c")).unwrap();

    store.move_host(&a.id, Some(prod.id.clone()), 0).unwrap();
    store.move_host(&c.id, Some(prod.id.clone()), 0).unwrap();

    let reopened = HostStore::open(&path).unwrap();
    assert_eq!(names(&reopened, Some(&prod.id)), ["c", "a"]);
    assert_eq!(names(&reopened, None), ["b"]);
    assert_eq!(reopened.get(&b.id).unwrap().group_id, None);
}

#[test]
fn hosts_reorder_within_their_group() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let a = store.upsert(None, draft("a")).unwrap();
    store.upsert(None, draft("b")).unwrap();
    let c = store.upsert(None, draft("c")).unwrap();

    // Indexes count the Group's Hosts without the one being moved.
    store.move_host(&a.id, None, 1).unwrap();
    assert_eq!(names(&store, None), ["b", "a", "c"]);
    store.move_host(&c.id, None, 0).unwrap();
    assert_eq!(names(&store, None), ["c", "b", "a"]);
    store.move_host(&c.id, None, 99).unwrap();
    assert_eq!(
        names(&HostStore::open(&path).unwrap(), None),
        ["b", "a", "c"]
    );
}

#[test]
fn editing_a_host_keeps_it_in_its_group() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let prod = store.create_group("Prod", None).unwrap();
    let a = store.upsert(None, draft("a")).unwrap();
    store.move_host(&a.id, Some(prod.id.clone()), 0).unwrap();

    store.upsert(Some(a.id.clone()), draft("a2")).unwrap();

    assert_eq!(names(&store, Some(&prod.id)), ["a2"]);
}

/// Names of the Groups under `parent`, in order.
fn group_names(store: &HostStore, parent: Option<&GroupId>) -> Vec<String> {
    store
        .groups()
        .iter()
        .filter(|g| g.parent_id.as_ref() == parent)
        .map(|g| g.name.clone())
        .collect()
}

#[test]
fn groups_move_between_parents_and_reorder() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let prod = store.create_group("Prod", None).unwrap();
    let staging = store.create_group("Staging", None).unwrap();
    let dev = store.create_group("Dev", None).unwrap();

    store.move_group(&dev.id, None, 0).unwrap();
    assert_eq!(group_names(&store, None), ["Dev", "Prod", "Staging"]);

    store
        .move_group(&staging.id, Some(prod.id.clone()), 0)
        .unwrap();

    let reopened = HostStore::open(&path).unwrap();
    assert_eq!(group_names(&reopened, None), ["Dev", "Prod"]);
    assert_eq!(group_names(&reopened, Some(&prod.id)), ["Staging"]);
}

#[test]
fn a_group_cannot_move_into_itself_or_its_descendants() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let prod = store.create_group("Prod", None).unwrap();
    let web = store.create_group("Web", Some(prod.id.clone())).unwrap();
    let edge = store.create_group("Edge", Some(web.id.clone())).unwrap();

    for target in [&prod, &web, &edge] {
        assert!(matches!(
            store.move_group(&prod.id, Some(target.id.clone()), 0),
            Err(HostStoreError::InvalidMove)
        ));
    }
    assert_eq!(
        group_names(&HostStore::open(&path).unwrap(), None),
        ["Prod"]
    );
}

#[test]
fn moving_into_an_unknown_group_is_an_error() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let a = store.upsert(None, draft("a")).unwrap();
    let g = store.create_group("G", None).unwrap();
    let ghost = GroupId::from("ghost".to_owned());

    assert!(matches!(
        store.move_host(&a.id, Some(ghost.clone()), 0),
        Err(HostStoreError::GroupNotFound(_))
    ));
    assert!(matches!(
        store.move_group(&g.id, Some(ghost.clone()), 0),
        Err(HostStoreError::GroupNotFound(_))
    ));
    assert!(matches!(
        store.create_group("H", Some(ghost)),
        Err(HostStoreError::GroupNotFound(_))
    ));
}

#[test]
fn a_group_can_be_renamed_but_not_to_a_blank_name() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let g = store.create_group("Prod", None).unwrap();

    let renamed = store.rename_group(&g.id, " Production ").unwrap();

    assert_eq!(renamed.name, "Production");
    assert_eq!(
        group_names(&HostStore::open(&path).unwrap(), None),
        ["Production"]
    );
    assert!(matches!(
        store.rename_group(&g.id, "  "),
        Err(HostStoreError::Invalid("name"))
    ));
    assert!(matches!(
        store.create_group("", None),
        Err(HostStoreError::Invalid("name"))
    ));
}

#[test]
fn deleting_a_group_keeps_its_contents_in_its_parent() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let prod = store.create_group("Prod", None).unwrap();
    let web = store.create_group("Web", Some(prod.id.clone())).unwrap();
    let edge = store.create_group("Edge", Some(web.id.clone())).unwrap();
    let a = store.upsert(None, draft("a")).unwrap();
    let b = store.upsert(None, draft("b")).unwrap();
    store.move_host(&a.id, Some(prod.id.clone()), 0).unwrap();
    store.move_host(&b.id, Some(web.id.clone()), 0).unwrap();

    store.delete_group(&web.id).unwrap();

    let reopened = HostStore::open(&path).unwrap();
    assert_eq!(names(&reopened, Some(&prod.id)), ["a", "b"]);
    assert_eq!(group_names(&reopened, Some(&prod.id)), ["Edge"]);
    assert_eq!(reopened.groups().len(), 2);
    assert!(reopened.groups().iter().any(|g| g.id == edge.id));
    assert!(matches!(
        store.delete_group(&web.id),
        Err(HostStoreError::GroupNotFound(_))
    ));
}

#[test]
fn a_duplicated_host_is_a_new_host_right_after_the_original() {
    let (_dir, path) = store_path();
    let mut store = HostStore::open(&path).unwrap();
    let prod = store.create_group("Prod", None).unwrap();
    let a = store.upsert(None, draft("a")).unwrap();
    let b = store.upsert(None, draft("b")).unwrap();
    store.move_host(&a.id, Some(prod.id.clone()), 0).unwrap();
    store.move_host(&b.id, Some(prod.id.clone()), 1).unwrap();

    let copy = store.duplicate_host(&a.id, "a copy").unwrap();

    assert_ne!(copy.id, a.id);
    assert_eq!(copy.group_id, Some(prod.id.clone()));
    assert_eq!(
        (copy.address.as_str(), copy.port, copy.user.as_str()),
        ("10.0.0.5", 22, "deploy")
    );
    let reopened = HostStore::open(&path).unwrap();
    assert_eq!(names(&reopened, Some(&prod.id)), ["a", "a copy", "b"]);
    assert_eq!(reopened.get(&copy.id), Some(&copy));
}
