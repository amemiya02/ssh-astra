use std::fs;

use sshastra_core::hosts::HostId;
use sshastra_core::snippets::{SnippetDraft, SnippetStore, SnippetStoreError};

fn draft() -> SnippetDraft {
    SnippetDraft {
        name: " Check disk ".into(),
        command: "  printf '%s\\n' '${dir:/}'\ndf -h  \n".into(),
        group: Some(" Ops ".into()),
        host_ids: vec!["host-1".to_owned().into(), "host-2".to_owned().into()],
        send_enter: false,
    }
}

#[test]
fn snippet_changes_survive_reopen_and_keep_every_command_character() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("snippets.json");
    let mut store = SnippetStore::open(&path).unwrap();
    assert!(store.list().is_empty());
    assert!(!path.exists());

    let original = store.upsert(None, draft()).unwrap();
    assert_eq!(original.draft.name, "Check disk");
    assert_eq!(original.draft.group.as_deref(), Some("Ops"));
    assert_eq!(original.draft.command, draft().command);
    assert_eq!(original.draft.host_ids, draft().host_ids);
    assert!(!original.draft.send_enter);
    assert_eq!(
        SnippetStore::open(&path).unwrap().list(),
        std::slice::from_ref(&original)
    );

    let mut update = draft();
    update.group = Some(" ".into());
    update.host_ids = vec![HostId::from("host-2".to_owned()); 2];
    update.send_enter = true;
    let edited = store.upsert(Some(original.id.clone()), update).unwrap();
    assert_eq!(edited.id, original.id);
    assert_eq!(edited.draft.group, None);
    assert_eq!(edited.draft.host_ids, [HostId::from("host-2".to_owned())]);
    assert!(edited.draft.send_enter);
    assert_eq!(SnippetStore::open(&path).unwrap().list(), &[edited]);

    store.delete(&original.id).unwrap();
    assert!(SnippetStore::open(&path).unwrap().list().is_empty());
}

#[test]
fn current_version_can_load_minimal_data_and_uses_default_enter() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("snippets.json");
    fs::write(
        &path,
        r#"{"version":1,"snippets":[{"id":"fixed","name":"Where am I?","command":"pwd"}]}"#,
    )
    .unwrap();
    let mut store = SnippetStore::open(&path).unwrap();
    let sample = &store.list()[0];
    assert!(sample.draft.send_enter);
    assert!(sample.draft.host_ids.is_empty());
    assert_eq!(sample.draft.group, None);
    store.upsert(None, draft()).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(json["version"], 1);
    assert_eq!(json["snippets"][0]["id"], "fixed");
}

#[test]
fn corrupt_and_newer_files_are_reported_without_being_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("snippets.json");
    for text in [
        "{ invalid",
        r#"{"version":1,"snippets":[] , "bad":}"#,
        r#"{"version":1,"snippets":[{"id":"fixed","name":"Missing command"}]}"#,
    ] {
        fs::write(&path, text).unwrap();
        assert!(matches!(
            SnippetStore::open(&path),
            Err(SnippetStoreError::Corrupt(_))
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
    }
    let newer = r#"{"version":99,"futureField":true}"#;
    fs::write(&path, newer).unwrap();
    assert!(matches!(
        SnippetStore::open(&path),
        Err(SnippetStoreError::UnsupportedVersion(99))
    ));
    assert_eq!(fs::read_to_string(&path).unwrap(), newer);
}

#[test]
fn a_failed_atomic_replacement_leaves_the_previous_snapshot_and_cleans_its_stage() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("snippets.json");
    let backup = dir.path().join("previous.json");
    let mut store = SnippetStore::open(&path).unwrap();
    let original = store.upsert(None, draft()).unwrap();
    fs::rename(&path, &backup).unwrap();
    fs::create_dir(&path).unwrap();

    assert!(matches!(
        store.delete(&original.id),
        Err(SnippetStoreError::Io { .. })
    ));
    assert_eq!(store.list(), std::slice::from_ref(&original));
    assert_eq!(
        SnippetStore::open(&backup).unwrap().list(),
        std::slice::from_ref(&original)
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    fs::remove_dir(&path).unwrap();
    fs::rename(&backup, &path).unwrap();
    store.delete(&original.id).unwrap();
    assert!(SnippetStore::open(&path).unwrap().list().is_empty());
}

#[test]
fn export_and_import_round_trip_snippet_drafts_and_assign_new_ids() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("snippets.json");
    let export = dir.path().join("sshastra-snippets.json");
    let destination = dir.path().join("destination.json");
    let mut store = SnippetStore::open(&path).unwrap();
    let original = store.upsert(None, draft()).unwrap();
    let original_bytes = fs::read(&path).unwrap();
    store.export_to(&export).unwrap();

    let mut imported = SnippetStore::open(&destination).unwrap();
    let report = imported.import_from(&export).unwrap();
    assert!(report.skipped.is_empty());
    assert_eq!(report.added.len(), 1);
    assert_eq!(report.added[0].draft, original.draft);
    assert_ne!(report.added[0].id, original.id);
    assert_eq!(
        SnippetStore::open(&destination).unwrap().list(),
        report.added
    );
    assert_eq!(fs::read(&path).unwrap(), original_bytes);
}

#[test]
fn import_skips_every_duplicate_name_against_saved_and_earlier_imported_snippets() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("snippets.json");
    let incoming = dir.path().join("incoming.json");
    let mut store = SnippetStore::open(&path).unwrap();
    let original = store.upsert(None, draft()).unwrap();
    fs::write(
        &incoming,
        r#"{"format":"sshastra-snippets","version":1,"snippets":[
            {"id":"a","name":" Check disk ","command":"different"},
            {"id":"b","name":" uptime  ","command":"first"},
            {"id":"c","name":"uptime","command":"second"},
            {"id":"d","name":"check disk","command":"different case"},
            {"id":"e","name":"Check disk","command":"different again"}
        ]}"#,
    )
    .unwrap();

    let report = store.import_from(&incoming).unwrap();
    assert_eq!(report.skipped, ["Check disk", "uptime", "Check disk"]);
    assert_eq!(report.added.len(), 2);
    assert_eq!(report.added[0].draft.name, "uptime");
    assert_eq!(report.added[0].draft.command, "first");
    assert_eq!(report.added[1].draft.name, "check disk");
    assert_eq!(store.list()[0], original);
    assert_eq!(SnippetStore::open(&path).unwrap().list(), store.list());

    let saved = fs::read(&path).unwrap();
    let repeated = store.import_from(&incoming).unwrap();
    assert!(repeated.added.is_empty());
    assert_eq!(
        repeated.skipped,
        ["Check disk", "uptime", "uptime", "check disk", "Check disk"]
    );
    assert_eq!(fs::read(&path).unwrap(), saved);
}

#[test]
fn rejected_imports_leave_the_preexisting_library_intact() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("snippets.json");
    let incoming = dir.path().join("incoming.json");
    let backup = dir.path().join("previous.json");
    let mut store = SnippetStore::open(&path).unwrap();
    let original = store.upsert(None, draft()).unwrap();
    let saved = fs::read(&path).unwrap();

    for malformed in [
        r#"{"format":"sshastra-hosts","version":1,"snippets":[]}"#,
        r#"{"version":1,"snippets":[{"id":"valid","name":"New","command":"pwd"},
            {"id":"bad","name":"Check disk","command":" "}]}"#,
        r#"{"version":1,"snippets":[{"id":"bad","name":"New","command":"pwd","hostIds":"all"}]}"#,
    ] {
        fs::write(&incoming, malformed).unwrap();
        assert!(matches!(
            store.import_from(&incoming),
            Err(SnippetStoreError::Corrupt(_))
        ));
        assert_eq!(store.list(), std::slice::from_ref(&original));
        assert_eq!(fs::read(&path).unwrap(), saved);
    }
    fs::write(&incoming, r#"{"version":99,"snippets":[]}"#).unwrap();
    assert!(matches!(
        store.import_from(&incoming),
        Err(SnippetStoreError::UnsupportedVersion(99))
    ));
    assert_eq!(store.list(), std::slice::from_ref(&original));
    assert_eq!(fs::read(&path).unwrap(), saved);

    fs::write(
        &incoming,
        r#"{"version":1,"snippets":[{"id":"a","name":"New","command":"pwd"}]}"#,
    )
    .unwrap();
    fs::rename(&path, &backup).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(matches!(
        store.import_from(&incoming),
        Err(SnippetStoreError::Io { .. })
    ));
    assert_eq!(store.list(), std::slice::from_ref(&original));
    assert_eq!(fs::read(&backup).unwrap(), saved);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 3);
}
