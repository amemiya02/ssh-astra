//! HostStore: saved Hosts in a versioned JSON file that survives restarts.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use sshastra_core::hosts::{HostAuth, HostDraft, HostStore, HostStoreError};

fn draft(name: &str) -> HostDraft {
    HostDraft {
        name: name.into(),
        address: "10.0.0.5".into(),
        port: 2222,
        user: "deploy".into(),
        auth: HostAuth::Password,
    }
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
    assert_eq!(json["version"], 1);
    assert_eq!(json["hosts"][0]["name"], "web");
    assert_eq!(json["hosts"][0]["auth"]["type"], "password");
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
