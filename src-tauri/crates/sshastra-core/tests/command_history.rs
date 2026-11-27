use std::fs;

use serde_json::json;
use sshastra_core::hosts::{HostDraft, HostId, HostStore};
use sshastra_core::terminal::{CommandHistory, TerminalSettings};

fn draft(name: &str) -> HostDraft {
    serde_json::from_value(json!({
        "name": name,
        "address": "test.example",
        "port": 22,
        "user": "test",
        "auth": { "type": "password" },
    }))
    .unwrap()
}

#[test]
fn history_is_opt_in_and_local_to_each_saved_host() {
    let dir = tempfile::tempdir().unwrap();
    let mut hosts = HostStore::open(dir.path().join("hosts.json")).unwrap();
    let first = hosts.upsert(None, draft("first")).unwrap();
    let second = hosts.upsert(None, draft("second")).unwrap();
    let history_dir = dir.path().join("command-history");
    let history = CommandHistory::new(history_dir.clone());
    let enabled = TerminalSettings {
        command_history: true,
        ..TerminalSettings::default()
    };
    history.clear(&first.id).unwrap();
    for (settings, command) in [
        (TerminalSettings::default(), "echo disabled"),
        (
            TerminalSettings {
                shell_integration: false,
                ..enabled.clone()
            },
            "echo no integration",
        ),
        (enabled.clone(), " echo private"),
        (enabled.clone(), ""),
    ] {
        history
            .record(&settings, &hosts, &first.id, command)
            .unwrap();
    }
    let temporary = HostId::from("unsaved-host".to_owned());
    history
        .record(&enabled, &hosts, &temporary, "echo temporary")
        .unwrap();
    assert!(history.list(&temporary).unwrap().is_empty());
    assert!(history.list(&first.id).unwrap().is_empty());
    assert!(!history_dir.exists());

    let command = "echo 'synthetic command history entry'";
    let multiline = "printf '%s\n' '分\n行'";
    history
        .record(&enabled, &hosts, &first.id, command)
        .unwrap();
    history
        .record(&enabled, &hosts, &first.id, multiline)
        .unwrap();
    history
        .record(&enabled, &hosts, &first.id, command)
        .unwrap();
    history.record(&enabled, &hosts, &second.id, "pwd").unwrap();
    history
        .record(
            &TerminalSettings::default(),
            &hosts,
            &first.id,
            "echo paused",
        )
        .unwrap();
    let reopened = CommandHistory::new(history_dir.clone());
    assert_eq!(reopened.list(&first.id).unwrap(), [command, multiline]);
    assert_eq!(reopened.list(&second.id).unwrap(), ["pwd"]);
    assert!(fs::read_dir(&history_dir).unwrap().any(|entry| {
        let file = entry.unwrap();
        let text = fs::read_to_string(file.path()).unwrap();
        assert_eq!(file.path().extension().unwrap(), "json");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        }
        text.contains(command)
    }));

    let export = dir.path().join("hosts-export.json");
    hosts.export_to(&export).unwrap();
    let exported = fs::read_to_string(&export).unwrap();
    assert!(!exported.contains("synthetic command history entry"));
    assert!(!exported.contains("commandHistory"));
    assert!(!exported.contains("command-history"));

    reopened.clear(&first.id).unwrap();
    assert!(reopened.list(&first.id).unwrap().is_empty());
    assert_eq!(reopened.list(&second.id).unwrap(), ["pwd"]);
    assert_eq!(fs::read_dir(history_dir).unwrap().count(), 1);
}

#[test]
fn adding_a_command_keeps_the_newest_five_thousand_unique_lines() {
    let dir = tempfile::tempdir().unwrap();
    let mut hosts = HostStore::open(dir.path().join("hosts.json")).unwrap();
    let host = hosts.upsert(None, draft("test")).unwrap();
    let history_dir = dir.path().join("command-history");
    let history = CommandHistory::new(history_dir.clone());
    let enabled = TerminalSettings {
        command_history: true,
        ..TerminalSettings::default()
    };
    history
        .record(&enabled, &hosts, &host.id, "echo initial")
        .unwrap();
    let path = fs::read_dir(history_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    // Start from a full store without making five thousand durable writes.
    let full: Vec<_> = (0..5_000).map(|index| format!("echo {index}")).collect();
    fs::write(path, serde_json::to_vec(&full).unwrap()).unwrap();

    history
        .record(&enabled, &hosts, &host.id, "echo new")
        .unwrap();
    let after = history.list(&host.id).unwrap();
    assert_eq!(after.len(), 5_000);
    assert_eq!(after.first().unwrap(), "echo new");
    assert_eq!(after.last().unwrap(), "echo 4998");

    history
        .record(&enabled, &hosts, &host.id, "echo 11")
        .unwrap();
    let after = history.list(&host.id).unwrap();
    assert_eq!(after.len(), 5_000);
    assert_eq!(after.first().unwrap(), "echo 11");
    assert_eq!(after.iter().filter(|line| *line == "echo 11").count(), 1);
}
