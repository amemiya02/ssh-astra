//! LocalPty behaviour, observed only through the Terminal interface:
//! bytes written in, events (output, exit) coming out.

use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use sshastra_core::terminal::{LocalPty, ShellCommand, Terminal, TerminalEvent, TerminalSize};

const TIMEOUT: Duration = Duration::from_secs(10);
const SIZE: TerminalSize = TerminalSize { cols: 80, rows: 24 };

fn spawn(command: ShellCommand) -> (LocalPty, Receiver<TerminalEvent>) {
    let (tx, rx) = mpsc::channel();
    let pty = LocalPty::spawn(command, SIZE, move |event| {
        let _ = tx.send(event);
    })
    .expect("spawn local pty");
    (pty, rx)
}

/// Collects output until `needle` appears; panics on timeout or early exit.
fn read_until(rx: &Receiver<TerminalEvent>, needle: &str) -> String {
    let deadline = Instant::now() + TIMEOUT;
    let mut seen = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(TerminalEvent::Output(bytes)) => {
                seen.extend_from_slice(&bytes);
                let text = String::from_utf8_lossy(&seen).into_owned();
                if text.contains(needle) {
                    return text;
                }
            }
            Ok(event @ TerminalEvent::Connection(_)) => panic!("a Local terminal sent {event:?}"),
            Ok(TerminalEvent::Exit { code }) => panic!(
                "exited ({code:?}) before {needle:?}; output: {:?}",
                String::from_utf8_lossy(&seen)
            ),
            Err(_) => panic!(
                "timed out waiting for {needle:?}; output: {:?}",
                String::from_utf8_lossy(&seen)
            ),
        }
    }
}

/// Drains events until Exit; returns (all output, exit code).
fn read_to_exit(rx: &Receiver<TerminalEvent>) -> (String, Option<u32>) {
    let mut seen = Vec::new();
    loop {
        match rx.recv_timeout(TIMEOUT).expect("exit event before timeout") {
            TerminalEvent::Output(bytes) => seen.extend_from_slice(&bytes),
            event @ TerminalEvent::Connection(_) => panic!("a Local terminal sent {event:?}"),
            TerminalEvent::Exit { code } => {
                return (String::from_utf8_lossy(&seen).into_owned(), code)
            }
        }
    }
}

#[cfg(unix)]
fn sh(script: &str) -> ShellCommand {
    ShellCommand::new("/bin/sh").args(["-c", script])
}

#[cfg(unix)]
#[test]
fn streams_output_then_reports_exit_code() {
    let (_pty, rx) = spawn(sh("printf 'hello from pty'; exit 3"));
    let (output, code) = read_to_exit(&rx);
    assert!(output.contains("hello from pty"), "output: {output:?}");
    assert_eq!(code, Some(3));
}

#[cfg(unix)]
#[test]
fn delivers_large_output_completely_before_exit() {
    // 200k lines ≈ 1.3 MB: every byte must arrive, and Exit must come last.
    let (_pty, rx) = spawn(sh("seq 1 200000; exit 0"));
    let (output, code) = read_to_exit(&rx);
    assert_eq!(code, Some(0));
    assert!(
        output.trim_end().ends_with("200000"),
        "tail: {:?}",
        &output[output.len().saturating_sub(40)..]
    );
}

#[cfg(unix)]
#[test]
fn forwards_written_input_to_the_shell() {
    let (mut pty, rx) = spawn(sh("read line; echo \"got:$line\""));
    pty.write(b"ping\r").unwrap();
    read_until(&rx, "got:ping");
}

#[cfg(unix)]
#[test]
fn resize_is_seen_by_the_program() {
    let (mut pty, rx) = spawn(sh("read _; stty size"));
    pty.resize(TerminalSize {
        cols: 132,
        rows: 43,
    })
    .unwrap();
    pty.write(b"\r").unwrap();
    read_until(&rx, "43 132");
}

#[cfg(unix)]
#[test]
fn starts_with_the_requested_size() {
    let (_pty, rx) = spawn(sh("stty size"));
    read_until(&rx, "24 80");
}

#[cfg(unix)]
#[test]
fn close_ends_a_running_program() {
    let (mut pty, rx) = spawn(sh("sleep 30"));
    pty.close().unwrap();
    let (_output, _code) = read_to_exit(&rx);
}

#[cfg(unix)]
#[test]
fn passes_extra_environment_to_the_program() {
    let (_pty, rx) = spawn(sh("echo \"term=$TERM\"").env("TERM", "xterm-256color"));
    read_until(&rx, "term=xterm-256color");
}

#[test]
fn default_shell_starts_and_runs_a_command() {
    let (mut pty, rx) = spawn(ShellCommand::default_shell());
    // The typed command is echoed back, so the expected text must only
    // appear once the shell has actually evaluated it.
    #[cfg(unix)]
    let (input, expected) = (&b"echo sshastra-$((40+2))\r"[..], "sshastra-42");
    #[cfg(windows)]
    let (input, expected) = (&b"echo sshastra-%OS%\r"[..], "sshastra-Windows_NT");
    pty.write(input).unwrap();
    read_until(&rx, expected);
}

#[cfg(windows)]
#[test]
fn windows_command_streams_output_and_exits() {
    let (_pty, rx) = spawn(ShellCommand::new("cmd.exe").args(["/C", "echo hello from pty"]));
    let (output, code) = read_to_exit(&rx);
    assert!(output.contains("hello from pty"), "output: {output:?}");
    assert_eq!(code, Some(0));
}

#[test]
fn spawning_a_missing_program_is_an_error() {
    let result = LocalPty::spawn(
        ShellCommand::new("/definitely/not/a/real/shell-sshastra"),
        SIZE,
        |_| {},
    );
    assert!(result.is_err());
}
