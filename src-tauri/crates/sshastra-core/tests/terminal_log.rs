use std::sync::{Arc, Mutex};

use sshastra_core::terminal::{
    ConnectionState, OutputKind, OutputStatus, Result, Terminal, TerminalEvent, TerminalLogText,
    TerminalOutput, TerminalRegistry, TerminalSize,
};

#[test]
fn strips_controls_and_preserves_text_at_every_chunk_boundary() {
    let input = concat!(
        "\x1b[31mred\x1b[0m \x1b[2D\x1b(B",
        "\x1b]8;;https://example.org\x1b\\链接\x1b]8;;\x07",
        "\x1b]0;private title\x07\x1bPqdiscard\x1b\\\x1b_discard\x1b\\ \u{9b}32m😀\r\n",
        "work 00%\rwork 50%\rwork 100%\r\n",
        "abcde\rXY\nunfinished",
    )
    .as_bytes();

    for boundary in 0..=input.len() {
        let mut parser = TerminalLogText::default();
        let mut text = String::new();
        parser.feed(&input[..boundary], &mut text);
        parser.feed(&input[boundary..], &mut text);
        parser.finish(&mut text);

        assert_eq!(
            text, "red 链接 😀\nwork 100%\nXYcde\nunfinished",
            "boundary {boundary}"
        );
    }
}

const INITIAL_SIZE: TerminalSize = TerminalSize { cols: 80, rows: 24 };

struct ShellInput;

impl Terminal for ShellInput {
    fn write(&mut self, _data: &[u8]) -> Result<()> {
        Ok(())
    }

    fn resize(&mut self, _size: TerminalSize) -> Result<()> {
        Ok(())
    }

    fn close(&mut self) -> Result<()> {
        Ok(())
    }
}

#[test]
fn logs_output_between_start_and_stop_to_the_same_file_after_reconnect() {
    let folder = tempfile::tempdir().unwrap();
    let registry = TerminalRegistry::default();
    let statuses = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::new(TerminalOutput::new(
        "../../prod:数据库",
        INITIAL_SIZE,
        None,
        {
            let statuses = Arc::clone(&statuses);
            move |kind, status| statuses.lock().unwrap().push((kind, status))
        },
    ));
    let mut sink = log.wrap(|_| {});
    let id = registry.insert_with_output(Box::new(ShellInput), log);

    sink(TerminalEvent::Output(b"before\n".to_vec()));
    let path = registry.start_log(id, folder.path()).unwrap();
    assert_eq!(path.parent(), Some(folder.path()));
    assert!(path
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("prod-数据库-"));
    assert_eq!(registry.start_log(id, folder.path()).unwrap(), path);

    registry.write(id, b"client-only input").unwrap();
    sink(TerminalEvent::Output(b"first shell".to_vec()));
    sink(TerminalEvent::Connection(ConnectionState::Reconnecting {
        attempt: 1,
        attempts: 2,
    }));
    registry.reconnect(id).unwrap();
    sink(TerminalEvent::Connection(ConnectionState::Connected));
    sink(TerminalEvent::Output(b"second shell\r\n".to_vec()));
    registry.stop_log(id).unwrap();
    sink(TerminalEvent::Output(b"after\n".to_vec()));

    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "first shell\nsecond shell\n"
    );
    assert_eq!(std::fs::read_dir(folder.path()).unwrap().count(), 1);
    assert_eq!(
        *statuses.lock().unwrap(),
        [
            (OutputKind::Log, OutputStatus::Active),
            (OutputKind::Log, OutputStatus::Stopped)
        ]
    );
}

#[test]
fn newly_opened_terminals_create_distinct_automatic_logs_and_flush_on_exit() {
    let folder = tempfile::tempdir().unwrap();
    let registry = TerminalRegistry::default();
    let local_path = folder.path().to_path_buf();
    let output = b"\x1b[31mlocal before open resolves\x1b[0m\r\n";
    let assert_written_before_ipc = move |event| {
        if let TerminalEvent::Output(bytes) = event {
            assert_eq!(bytes.as_slice(), output.as_slice());
            let mut files = std::fs::read_dir(&local_path).unwrap();
            let path = files.next().unwrap().unwrap().path();
            assert!(files.next().is_none());
            assert_eq!(
                std::fs::read_to_string(path).unwrap(),
                "local before open resolves\n"
            );
        }
    };
    let local = Arc::new(TerminalOutput::new(
        "Local",
        INITIAL_SIZE,
        Some(folder.path().into()),
        |_, _| {},
    ));
    let mut local_sink = local.wrap(assert_written_before_ipc);
    local_sink(TerminalEvent::Output(output.to_vec()));
    registry.insert_with_output(Box::new(ShellInput), local);

    let remote = Arc::new(TerminalOutput::new(
        "Local",
        INITIAL_SIZE,
        Some(folder.path().into()),
        |_, _| {},
    ));
    let mut remote_sink = remote.wrap(|_| {});
    registry.insert_with_output(Box::new(ShellInput), remote);
    assert_eq!(std::fs::read_dir(folder.path()).unwrap().count(), 2);
    remote_sink(TerminalEvent::Output(b"a second terminal".to_vec()));

    local_sink(TerminalEvent::Exit { code: Some(0) });
    remote_sink(TerminalEvent::Exit { code: Some(0) });
    let mut logs: Vec<_> = std::fs::read_dir(folder.path())
        .unwrap()
        .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
        .collect();
    logs.sort();
    assert_eq!(logs, ["a second terminal", "local before open resolves\n"]);
}

#[test]
fn logs_a_large_output_event_across_the_buffer_boundary() {
    let folder = tempfile::tempdir().unwrap();
    let registry = TerminalRegistry::default();
    let log = Arc::new(TerminalOutput::new("Local", INITIAL_SIZE, None, |_, _| {}));
    let mut sink = log.wrap(|_| {});
    let id = registry.insert_with_output(Box::new(ShellInput), log);
    let path = registry.start_log(id, folder.path()).unwrap();

    let prefix = "x".repeat(64 * 1024 - 1);
    let burst = format!("{prefix}😀\r\n");
    sink(TerminalEvent::Output(burst.into_bytes()));
    registry.stop_log(id).unwrap();

    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        format!("{prefix}😀\n")
    );
}

#[test]
fn records_timed_output_and_size_changes_independently_of_terminal_log() {
    use serde_json::{json, Value};

    let folder = tempfile::tempdir().unwrap();
    let registry = TerminalRegistry::default();
    let statuses = Arc::new(Mutex::new(Vec::new()));
    let output = Arc::new(TerminalOutput::new("Build Host", INITIAL_SIZE, None, {
        let statuses = Arc::clone(&statuses);
        move |kind, status| statuses.lock().unwrap().push((kind, status))
    }));
    let mut sink = output.wrap(|_| {});
    let id = registry.insert_with_output(Box::new(ShellInput), output);

    let log = registry.start_log(id, folder.path()).unwrap();
    sink(TerminalEvent::Output(b"only in log\r\n".to_vec()));
    registry
        .resize(
            id,
            TerminalSize {
                cols: 100,
                rows: 30,
            },
        )
        .unwrap();
    let cast = registry.start_recording(id, folder.path()).unwrap();
    assert_eq!(cast.parent(), Some(folder.path()));
    assert_eq!(cast.extension().unwrap(), "cast");
    assert!(cast
        .file_stem()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("Build-Host-"));
    assert_eq!(registry.start_recording(id, folder.path()).unwrap(), cast);

    registry.write(id, b"private input").unwrap();
    let first = "\x1b[32m界\x1b[0m\r\n";
    sink(TerminalEvent::Output(first.as_bytes()[..6].into()));
    sink(TerminalEvent::Output(first.as_bytes()[6..].into()));
    std::thread::sleep(std::time::Duration::from_millis(15));
    let updated = TerminalSize {
        cols: 120,
        rows: 40,
    };
    registry.resize(id, updated).unwrap();
    registry.resize(id, updated).unwrap();
    sink(TerminalEvent::Cwd("/not/in/the/file".into()));
    sink(TerminalEvent::Output(b"after resize\r\n".to_vec()));

    registry.stop_recording(id).unwrap();
    sink(TerminalEvent::Output(b"log still active\r\n".to_vec()));
    sink(TerminalEvent::Exit { code: Some(0) });
    assert!(registry.start_recording(id, folder.path()).is_err());

    let contents = std::fs::read_to_string(cast).unwrap();
    assert!(contents.ends_with('\n'));
    let mut lines = contents
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap());
    let header = lines.next().unwrap();
    assert_eq!(header["version"], 2);
    assert_eq!(header["width"], 100);
    assert_eq!(header["height"], 30);
    assert!(header["timestamp"].as_u64().unwrap() > 0);
    let events: Vec<_> = lines.collect();
    assert_eq!(events.len(), 4);
    assert!(events
        .iter()
        .all(|event| event.as_array().unwrap().len() == 3));
    let times: Vec<_> = events
        .iter()
        .map(|event| event[0].as_f64().unwrap())
        .collect();
    assert!(times[0] >= 0.0 && times.windows(2).all(|pair| pair[0] <= pair[1]));
    assert!(times[2] - times[0] >= 0.010);
    assert_eq!(
        events[0].as_array().unwrap()[1..],
        [json!("o"), json!("\x1b[32m")]
    );
    assert_eq!(
        events[1].as_array().unwrap()[1..],
        [json!("o"), json!("界\x1b[0m\r\n")]
    );
    assert_eq!(
        events[2].as_array().unwrap()[1..],
        [json!("r"), json!("120x40")]
    );
    assert_eq!(
        events[3].as_array().unwrap()[1..],
        [json!("o"), json!("after resize\r\n")]
    );
    assert_eq!(
        std::fs::read_to_string(log).unwrap(),
        "only in log\n界\nafter resize\nlog still active\n"
    );
    assert_eq!(
        *statuses.lock().unwrap(),
        [
            (OutputKind::Log, OutputStatus::Active),
            (OutputKind::Recording, OutputStatus::Active),
            (OutputKind::Recording, OutputStatus::Stopped),
            (OutputKind::Log, OutputStatus::Stopped),
        ]
    );
}

#[test]
fn recording_flushes_on_exit_across_large_and_incomplete_output_chunks() {
    let folder = tempfile::tempdir().unwrap();
    let registry = TerminalRegistry::default();
    let output = Arc::new(TerminalOutput::new("Local", INITIAL_SIZE, None, |_, _| {}));
    let mut sink = output.wrap(|_| {});
    let id = registry.insert_with_output(Box::new(ShellInput), output);
    let log = registry.start_log(id, folder.path()).unwrap();
    assert!(registry
        .start_recording(id, std::path::Path::new("relative-directory"))
        .is_err());
    let cast = registry.start_recording(id, folder.path()).unwrap();
    registry.stop_log(id).unwrap();
    let prefix = "x".repeat(64 * 1024 - 1);
    let text = format!("{prefix}😀\x1b[0m\r\n");
    let mut bytes = text.as_bytes().to_vec();
    bytes.extend([0xf0, 0x9f]);
    sink(TerminalEvent::Output(bytes));
    sink(TerminalEvent::Exit { code: None });

    let contents = std::fs::read_to_string(cast).unwrap();
    let lines: Vec<_> = contents.lines().collect();
    assert_eq!(lines.len(), 4);
    let mut recorded = String::new();
    for line in &lines[1..] {
        let (time, code, data): (f64, String, String) = serde_json::from_str(line).unwrap();
        assert!(time >= 0.0);
        assert_eq!(code, "o");
        recorded.push_str(&data);
    }
    assert_eq!(recorded, format!("{text}�"));
    assert!(std::fs::read_to_string(log).unwrap().is_empty());
}
