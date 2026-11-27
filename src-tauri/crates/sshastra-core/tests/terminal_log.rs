use std::sync::{Arc, Mutex};

use sshastra_core::terminal::{
    ConnectionState, Result, Terminal, TerminalEvent, TerminalLog, TerminalLogStatus,
    TerminalLogText, TerminalRegistry, TerminalSize,
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
    let log = Arc::new(TerminalLog::new("../../prod:数据库", None, {
        let statuses = Arc::clone(&statuses);
        move |status| statuses.lock().unwrap().push(status)
    }));
    let mut sink = log.wrap(|_| {});
    let id = registry.insert_logged(Box::new(ShellInput), log);

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
        [TerminalLogStatus::Active, TerminalLogStatus::Stopped]
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
    let local = Arc::new(TerminalLog::new(
        "Local",
        Some(folder.path().into()),
        |_| {},
    ));
    let mut local_sink = local.wrap(assert_written_before_ipc);
    local_sink(TerminalEvent::Output(output.to_vec()));
    registry.insert_logged(Box::new(ShellInput), local);

    let remote = Arc::new(TerminalLog::new(
        "Local",
        Some(folder.path().into()),
        |_| {},
    ));
    let mut remote_sink = remote.wrap(|_| {});
    registry.insert_logged(Box::new(ShellInput), remote);
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
    let log = Arc::new(TerminalLog::new("Local", None, |_| {}));
    let mut sink = log.wrap(|_| {});
    let id = registry.insert_logged(Box::new(ShellInput), log);
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
