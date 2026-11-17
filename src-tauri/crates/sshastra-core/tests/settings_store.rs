//! SettingsStore: app settings in a versioned JSON file that survives restarts.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::json;
use sshastra_core::settings::{SettingsError, SettingsStore, CURRENT_VERSION};

fn store_path() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config").join("settings.json");
    (dir, path)
}

fn write_file(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

#[test]
fn starts_with_no_saved_sections_when_there_is_no_file_yet() {
    let (_dir, path) = store_path();
    let store = SettingsStore::open(&path).unwrap();
    assert!(store.sections().is_empty());
    assert!(!path.exists(), "opening must not create the file");
}

#[test]
fn saved_sections_are_there_after_a_restart() {
    let (_dir, path) = store_path();
    {
        let mut store = SettingsStore::open(&path).unwrap();
        store.set("appearance", json!({ "theme": "dark" })).unwrap();
        store.set("general", json!({ "language": "zh" })).unwrap();
        store
            .set("appearance", json!({ "theme": "light" }))
            .unwrap();
    }

    let reopened = SettingsStore::open(&path).unwrap();

    assert_eq!(
        reopened.sections().get("appearance"),
        Some(&json!({ "theme": "light" }))
    );
    assert_eq!(
        reopened.sections().get("general"),
        Some(&json!({ "language": "zh" }))
    );
}

#[test]
fn the_file_records_its_format_version() {
    let (_dir, path) = store_path();
    let mut store = SettingsStore::open(&path).unwrap();
    store.set("general", json!({ "language": "en" })).unwrap();

    let on_disk: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(CURRENT_VERSION, 1);
    assert_eq!(on_disk["version"], json!(1));
    assert_eq!(on_disk["general"], json!({ "language": "en" }));
}

#[test]
fn reads_a_version_1_file_written_by_an_earlier_build() {
    let (_dir, path) = store_path();
    write_file(
        &path,
        r#"{ "version": 1, "appearance": { "theme": "dark" }, "layout": { "dock": "bottom", "groups": {} } }"#,
    );

    let store = SettingsStore::open(&path).unwrap();

    assert_eq!(
        store.sections().get("appearance"),
        Some(&json!({ "theme": "dark" }))
    );
    assert_eq!(
        store.sections().get("layout"),
        Some(&json!({ "dock": "bottom", "groups": {} }))
    );
}

#[test]
fn sections_this_build_does_not_know_survive_a_save() {
    let (_dir, path) = store_path();
    write_file(&path, r#"{ "version": 1, "fromALaterTicket": { "x": 1 } }"#);

    let mut store = SettingsStore::open(&path).unwrap();
    store.set("general", json!({ "language": "zh" })).unwrap();

    let reopened = SettingsStore::open(&path).unwrap();
    assert_eq!(
        reopened.sections().get("fromALaterTicket"),
        Some(&json!({ "x": 1 }))
    );
}

#[test]
fn refuses_a_file_from_a_newer_build_and_leaves_it_alone() {
    let (_dir, path) = store_path();
    let newer = r#"{ "version": 99, "general": { "language": "zh" } }"#;
    write_file(&path, newer);

    let err = SettingsStore::open(&path)
        .err()
        .expect("a newer version must be refused");

    assert!(matches!(err, SettingsError::UnsupportedVersion(99)));
    assert_eq!(fs::read_to_string(&path).unwrap(), newer);
}

#[test]
fn a_damaged_file_is_reported_not_overwritten() {
    let (_dir, path) = store_path();
    for damaged in ["{ not json", r#"{ "general": {} }"#, "[1, 2]"] {
        write_file(&path, damaged);
        let err = SettingsStore::open(&path)
            .err()
            .expect("a damaged file must be refused");
        assert!(
            matches!(err, SettingsError::Corrupt(_)),
            "{damaged}: {err:?}"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), damaged);
    }
}

#[test]
fn the_version_key_is_not_a_section() {
    let (_dir, path) = store_path();
    let mut store = SettingsStore::open(&path).unwrap();
    assert!(matches!(
        store.set("version", json!(2)),
        Err(SettingsError::ReservedSection)
    ));
    assert!(matches!(
        store.set("", json!({})),
        Err(SettingsError::ReservedSection)
    ));
}

#[derive(Debug, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Connection {
    keepalive_seconds: u32,
    agent: bool,
}

#[test]
fn core_code_reads_a_section_typed_with_defaults_for_what_is_missing_or_bad() {
    let (_dir, path) = store_path();
    let mut store = SettingsStore::open(&path).unwrap();

    assert_eq!(
        store.section::<Connection>("connection"),
        Connection::default()
    );

    store
        .set("connection", json!({ "keepaliveSeconds": 30 }))
        .unwrap();
    assert_eq!(
        store.section::<Connection>("connection"),
        Connection {
            keepalive_seconds: 30,
            agent: false
        }
    );

    store
        .set("connection", json!({ "keepaliveSeconds": "soon" }))
        .unwrap();
    assert_eq!(
        store.section::<Connection>("connection"),
        Connection::default()
    );
}

#[test]
fn the_keepalive_interval_comes_from_the_connection_section() {
    use sshastra_core::ssh::ConnectionSettings;
    use std::time::Duration;
    let (_dir, path) = store_path();
    let mut store = SettingsStore::open(&path).unwrap();
    let read = |store: &SettingsStore| {
        store
            .section::<ConnectionSettings>(ConnectionSettings::SECTION)
            .keepalive_interval()
    };

    assert_eq!(read(&store), Some(Duration::from_secs(30)));
    store
        .set("connection", json!({ "keepaliveSeconds": 60 }))
        .unwrap();
    assert_eq!(read(&store), Some(Duration::from_secs(60)));
    store
        .set("connection", json!({ "keepaliveSeconds": 0 }))
        .unwrap();
    assert_eq!(read(&store), None);
}
