use std::fs;

use sshastra_core::forward::{ForwardDraft, ForwardKind};
use sshastra_core::hosts::{diff_open_ssh, HostDraft, HostStore};
use sshastra_core::ssh::ConnectionSettings;
use sshastra_core::ssh_config::{read_user_config, ParseContext};
use sshastra_core::ssh_config_export::{ConfigExport, INCLUDE_LINE};

#[test]
fn changing_user_config_updates_linked_hosts_and_offers_new_aliases() {
    let home = tempfile::tempdir().unwrap();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    let source = ssh.join("config");
    let path = home.path().join("hosts.json");
    let read = || {
        read_user_config(
            home.path(),
            &ParseContext { local_user: "tester".into() },
        )
        .unwrap()
    };
    fs::write(
        &source,
        "Host linked\n HostName old.example.net\n LocalForward 8123 app:80\nHost stale\nHost invalid\n",
    )
    .unwrap();
    let mut store = HostStore::open(&path).unwrap();
    store.import_open_ssh(read()).unwrap();
    let linked = store.list()[0].clone();
    let mut draft: HostDraft = serde_json::from_value(serde_json::to_value(&linked).unwrap()).unwrap();
    draft.address = "local-choice.example.net".into();
    draft.name = "Renamed".into();
    draft.tags = vec!["Shared".into()];
    store.upsert(Some(linked.id.clone()), draft).unwrap();
    let bookmark = store.add_bookmark(&linked.id, "~/logs").unwrap();
    let local_forward = store.save_forward(&linked.id, None, ForwardDraft {
        label: "Astra only".into(),
        auto_start: false,
        kind: ForwardKind::Dynamic { bind_address: "127.0.0.1".into(), bind_port: 1080 },
    }).unwrap();

    assert!(diff_open_ssh(store.list(), &read()).changed.is_empty());
    let config = format!(
        "{INCLUDE_LINE}\nHost linked\n HostName new.example.net\n LocalForward 8124 app:80\nHost new\n ProxyJump jumpuser@jump.example.net\nHost invalid\n Port nope\n"
    );
    fs::write(&source, &config).unwrap();
    fs::write(ssh.join("ssh-astra.conf"), "# Managed by SSH Astra.\nHost managed\n").unwrap();
    let user = read();
    let diff = diff_open_ssh(store.list(), &user);
    assert_eq!(diff.new, ["new"]);
    assert_eq!(diff.changed, ["linked"]);
    assert_eq!(diff.deleted, ["stale"]);

    let offer = store.sync_open_ssh(&user).unwrap();
    let store_after_sync = HostStore::open(&path).unwrap();
    let saved = store_after_sync.get(&linked.id).unwrap();
    assert_eq!(saved.name, "Renamed");
    assert_eq!(saved.tags, ["Shared"]);
    assert_eq!(saved.address, "new.example.net");
    assert_eq!(saved.bookmarks, [bookmark]);
    assert!(saved.forwards.contains(&local_forward));
    assert_eq!(saved.forwards.len(), 2);
    assert!(saved.forwards.iter().any(|rule| matches!(rule.kind, ForwardKind::Local { bind_port: 8124, .. })));
    assert_eq!(saved.open_ssh_source.as_ref().unwrap().alias, "linked");
    assert!(store_after_sync.list()[1].open_ssh_source.as_ref().unwrap().missing);
    assert!(!store_after_sync.list()[2].open_ssh_source.as_ref().unwrap().missing);
    assert_eq!(store_after_sync.list().len(), 3);

    let output = ConfigExport::new(home.path().to_owned())
        .refresh(store_after_sync.list(), &ConnectionSettings::default())
        .unwrap();
    assert!(output.aliases.is_empty());
    assert_eq!(fs::read_to_string(&source).unwrap(), config);

    let mut local: HostDraft = serde_json::from_value(serde_json::to_value(&linked).unwrap()).unwrap();
    local.name = "App through user config".into();
    local.jump_host = Some(linked.id.clone());
    store.upsert(None, local).unwrap();
    let output = ConfigExport::new(home.path().to_owned())
        .refresh(store.list(), &ConnectionSettings::default())
        .unwrap();
    assert_eq!(output.aliases, ["app-through-user-config"]);
    let fragment = fs::read_to_string(ssh.join("ssh-astra.conf")).unwrap();
    assert!(fragment.contains("    ProxyJump linked\n"));
    assert!(!fragment.contains("Host linked\n"));

    assert!(store.import_open_ssh_offered(&user, &offer).unwrap().is_some());
    let new = store.list().iter().find(|host| host.name == "new").unwrap();
    let jump = store.get(new.jump_host.as_ref().unwrap()).unwrap();
    assert_eq!(jump.address, "jump.example.net");
    assert_eq!(jump.user, "jumpuser");
    assert!(jump.open_ssh_source.is_some());
    assert!(diff_open_ssh(store.list(), &user).new.is_empty());

    fs::write(&source, format!("{config}Host stale\n")).unwrap();
    store.sync_open_ssh(&read()).unwrap();
    assert!(!store.list()[1].open_ssh_source.as_ref().unwrap().missing);
}

#[test]
fn incomplete_includes_preserve_saved_sources_and_their_last_values() {
    let home = tempfile::tempdir().unwrap();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    fs::write(ssh.join("config"), "Include user.conf\nHost web\n HostName before.example.net\n").unwrap();
    fs::write(ssh.join("user.conf"), "Host linked\n HostName linked.example.net\n").unwrap();
    let read = || read_user_config(home.path(), &ParseContext { local_user: "tester".into() }).unwrap();
    let mut store = HostStore::open(home.path().join("hosts.json")).unwrap();
    store.import_open_ssh(read()).unwrap();

    fs::write(ssh.join("user.conf"), [0xff]).unwrap();
    fs::write(ssh.join("config"), "Include user.conf\nHost web\n HostName after.example.net\n").unwrap();
    let config = read();
    let diff = diff_open_ssh(store.list(), &config);
    assert!(diff.changed.is_empty());
    assert!(diff.deleted.is_empty());
    let report = store.sync_open_ssh(&config).unwrap();
    assert_eq!(report.issues.len(), 1);
    assert!(report.missing.is_empty());
    assert_eq!(store.list()[1].address, "before.example.net");

    fs::remove_file(ssh.join("user.conf")).unwrap();
    let report = store.sync_open_ssh(&read()).unwrap();
    assert_eq!(report.updated, ["web"]);
    assert_eq!(report.missing, ["linked"]);
    assert_eq!(store.list()[1].address, "after.example.net");
}

#[test]
fn an_import_review_cannot_add_an_alias_that_became_available_after_review() {
    let home = tempfile::tempdir().unwrap();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    fs::write(ssh.join("config"), "Host blocked\nHost offered\n").unwrap();
    let config = read_user_config(home.path(), &ParseContext { local_user: "tester".into() }).unwrap();
    let mut store = HostStore::open(home.path().join("hosts.json")).unwrap();
    let local = store.upsert(None, serde_json::from_value(serde_json::json!({
        "name": "blocked", "address": "local.example.net", "port": 22, "user": "tester",
        "auth": { "type": "auto" },
    })).unwrap()).unwrap();
    let review = store.sync_open_ssh(&config).unwrap();
    assert_eq!(review.available, ["offered"]);

    store.delete(&local.id).unwrap();
    assert!(store.import_open_ssh_offered(&config, &review).unwrap().is_none());
    assert!(store.list().is_empty());
    assert_eq!(diff_open_ssh(store.list(), &config).new, ["blocked", "offered"]);
}

#[test]
fn config_provenance_stays_in_the_local_host_library() {
    use sshastra_core::ssh_config::parse;

    let home = tempfile::tempdir().unwrap();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    let context = ParseContext { local_user: "tester".into() };
    fs::write(ssh.join("config"), "Host tracked\n").unwrap();
    let config = read_user_config(home.path(), &context).unwrap();
    let path = home.path().join("hosts.json");
    let mut store = HostStore::open(&path).unwrap();
    store.import_open_ssh(config).unwrap();
    store.import_config(parse("Host other\n", &context, &mut |_| Ok(Vec::new()))).unwrap();
    assert!(store.list()[0].open_ssh_source.is_some());
    assert!(store.list()[1].open_ssh_source.is_none());

    let exported = store.export();
    assert!(!exported.contains("openSshSource"));
    let mut imported = HostStore::open(home.path().join("imported.json")).unwrap();
    imported.import(&fs::read_to_string(&path).unwrap()).unwrap();
    assert!(imported.list().iter().all(|host| host.open_ssh_source.is_none()));
}
