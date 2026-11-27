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
