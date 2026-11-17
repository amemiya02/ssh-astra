//! TerminalRegistry: open Terminals addressed by id, as the IPC layer uses them.

use std::sync::{Arc, Mutex};

use sshastra_core::terminal::{
    Result, Terminal, TerminalError, TerminalId, TerminalRegistry, TerminalSize,
};

#[derive(Default)]
struct Log(Mutex<Vec<String>>);

impl Log {
    fn push(&self, entry: String) {
        self.0.lock().unwrap().push(entry);
    }

    fn entries(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

struct FakeTerminal(Arc<Log>);

impl Terminal for FakeTerminal {
    fn write(&mut self, data: &[u8]) -> Result<()> {
        self.0
            .push(format!("write {}", String::from_utf8_lossy(data)));
        Ok(())
    }
    fn resize(&mut self, size: TerminalSize) -> Result<()> {
        self.0.push(format!("resize {}x{}", size.cols, size.rows));
        Ok(())
    }
    fn close(&mut self) -> Result<()> {
        self.0.push("close".into());
        Ok(())
    }
}

#[test]
fn routes_input_and_resize_to_the_right_terminal() {
    let registry = TerminalRegistry::default();
    let (a_log, b_log) = (Arc::new(Log::default()), Arc::new(Log::default()));
    let a = registry.insert(Box::new(FakeTerminal(a_log.clone())));
    let b = registry.insert(Box::new(FakeTerminal(b_log.clone())));
    assert_ne!(a, b);

    registry.write(a, b"ls\r").unwrap();
    registry
        .resize(
            b,
            TerminalSize {
                cols: 100,
                rows: 30,
            },
        )
        .unwrap();

    assert_eq!(a_log.entries(), ["write ls\r"]);
    assert_eq!(b_log.entries(), ["resize 100x30"]);
}

#[test]
fn close_closes_the_terminal_and_forgets_it() {
    let registry = TerminalRegistry::default();
    let log = Arc::new(Log::default());
    let id = registry.insert(Box::new(FakeTerminal(log.clone())));

    registry.close(id).unwrap();

    assert_eq!(log.entries(), ["close"]);
    assert!(
        matches!(registry.write(id, b"x"), Err(TerminalError::NotFound(missing)) if missing == id)
    );
}

#[test]
fn ids_are_not_reused_after_close() {
    let registry = TerminalRegistry::default();
    let first = registry.insert(Box::new(FakeTerminal(Arc::default())));
    registry.close(first).unwrap();
    let second = registry.insert(Box::new(FakeTerminal(Arc::default())));
    assert_ne!(first, second);
}

#[test]
fn unknown_ids_are_reported() {
    let registry = TerminalRegistry::default();
    let id = TerminalId::from(42);
    assert!(matches!(
        registry.resize(id, TerminalSize { cols: 1, rows: 1 }),
        Err(TerminalError::NotFound(_))
    ));
    assert!(matches!(
        registry.close(id),
        Err(TerminalError::NotFound(_))
    ));
}
