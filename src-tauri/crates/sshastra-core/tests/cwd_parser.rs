//! The ShellIntegration output parser: finds the directories a shell reports
//! with OSC 7 (`ESC ] 7 ; file://host/path BEL`) in a Terminal's raw output,
//! however the output is cut into chunks, and hides the shell's output while
//! the hook is typed in.

use sshastra_core::terminal::{
    CwdParser, ShellIntegrationEvent, ShellIntegrationStatus, ShellOutput, TerminalEvent,
};

fn parse_all(chunks: &[&[u8]]) -> Vec<String> {
    let mut parser = CwdParser::default();
    chunks.iter().flat_map(|chunk| parser.feed(chunk)).collect()
}

#[test]
fn finds_a_reported_directory_between_other_output() {
    assert_eq!(
        parse_all(&[b"total 0\r\n\x1b]7;file://box/home/tester\x07tester@box:~$ "]),
        ["/home/tester"]
    );
}

#[test]
fn accepts_the_string_terminator_as_well_as_bel() {
    assert_eq!(
        parse_all(&[b"\x1b]7;file://box/srv/files\x1b\\$ "]),
        ["/srv/files"]
    );
}

#[test]
fn a_sequence_split_across_chunks_is_still_found() {
    let whole: &[u8] = b"x\x1b]7;file://box/srv/files/docs\x1b\\y";
    // Every possible cut, including right after ESC and inside the terminator.
    for cut in 1..whole.len() {
        let (a, b) = whole.split_at(cut);
        assert_eq!(parse_all(&[a, b]), ["/srv/files/docs"], "cut at {cut}");
    }
    let bytes: Vec<&[u8]> = whole.chunks(1).collect();
    assert_eq!(parse_all(&bytes), ["/srv/files/docs"], "one byte at a time");
}

#[test]
fn percent_encoded_spaces_and_non_ascii_are_decoded() {
    assert_eq!(
        parse_all(&[b"\x1b]7;file://box/tmp/my%20dir/%E6%97%A5%E6%9C%AC\x07"]),
        ["/tmp/my dir/日本"]
    );
}

#[test]
fn raw_utf8_paths_are_taken_as_they_are() {
    assert_eq!(
        parse_all(&["\x1b]7;file://box/tmp/a b/日本\x07".as_bytes()]),
        ["/tmp/a b/日本"]
    );
}

#[test]
fn an_empty_host_is_fine() {
    assert_eq!(parse_all(&[b"\x1b]7;file:///var/log\x07"]), ["/var/log"]);
}

#[test]
fn an_unfinished_sequence_reports_nothing_until_it_ends() {
    let mut parser = CwdParser::default();
    assert!(parser.feed(b"\x1b]7;file://box/tm").is_empty());
    assert!(parser.feed(b"p/half").is_empty());
    assert_eq!(parser.feed(b"\x07"), ["/tmp/half"]);
}

#[test]
fn a_sequence_cut_off_by_another_escape_is_dropped() {
    // CAN / ESC-not-followed-by-backslash abort the OSC; the next one still parses.
    assert_eq!(
        parse_all(&[b"\x1b]7;file://box/lost\x1b[0m\x1b]7;file://box/kept\x07"]),
        ["/kept"]
    );
    assert_eq!(
        parse_all(&[b"\x1b]7;file://box/lost\x18\x1b]7;file://box/kept\x07"]),
        ["/kept"]
    );
}

#[test]
fn other_osc_sequences_are_ignored() {
    assert_eq!(
        parse_all(&[b"\x1b]0;tester@box: ~\x07\x1b]777;notify;x\x07\x1b]7;file://box/home\x07"]),
        ["/home"]
    );
}

#[test]
fn a_runaway_sequence_does_not_grow_without_bound() {
    let mut parser = CwdParser::default();
    let junk = vec![b'a'; 1 << 20];
    assert!(parser.feed(b"\x1b]7;file://box/").is_empty());
    assert!(parser.feed(&junk).is_empty());
    assert!(
        parser.feed(b"\x07").is_empty(),
        "an oversized report is dropped"
    );
    assert_eq!(parser.feed(b"\x1b]7;file://box/ok\x07"), ["/ok"]);
}

#[test]
fn reports_that_are_not_paths_are_ignored() {
    assert!(parse_all(&[b"\x1b]7;http://box/x\x07\x1b]7;file://box\x07"]).is_empty());
}

const READY: &[u8] = b"\x1b]6973;ready\x07";

#[test]
fn output_is_shown_unchanged_when_nothing_is_hidden() {
    let mut out = ShellOutput::default();
    let shown = out.feed(b"ls\r\n\x1b]7;file://box/srv\x07$ ");
    assert_eq!(shown.output, b"ls\r\n\x1b]7;file://box/srv\x07$ ");
    assert_eq!(shown.events, [TerminalEvent::Cwd("/srv".into())]);
}

#[test]
fn hidden_output_up_to_the_ready_marker_is_dropped_and_the_prompt_line_cleared() {
    let mut out = ShellOutput::default();
    out.hide_until_ready();
    let echoed: &[u8] = b" [ -n \"$BASH_VERSION\" ] && eval '...'\r\n";
    assert!(out.feed(echoed).output.is_empty());
    assert!(out.is_hiding());
    let mut last = READY.to_vec();
    last.extend_from_slice(b"\x1b]7;file://box/home/me\x07me@box:~$ ");
    let shown = out.feed(&last);
    assert!(!out.is_hiding());
    assert_eq!(
        shown.output,
        b"\r\x1b[K\x1b]7;file://box/home/me\x07me@box:~$ "
    );
    assert_eq!(
        shown.events,
        [
            TerminalEvent::ShellIntegration(ShellIntegrationEvent::Availability {
                status: ShellIntegrationStatus::Available,
            }),
            TerminalEvent::Cwd("/home/me".into()),
        ]
    );
}

#[test]
fn a_ready_marker_split_across_chunks_still_ends_hiding() {
    for cut in 1..READY.len() {
        let mut out = ShellOutput::default();
        out.hide_until_ready();
        assert!(out.feed(&READY[..cut]).output.is_empty(), "cut at {cut}");
        let shown = out.feed(&[&READY[cut..], b"$ "].concat());
        assert_eq!(shown.output, b"\r\x1b[K$ ", "cut at {cut}");
    }
}

#[test]
fn revealing_without_the_marker_gives_back_what_was_held() {
    let mut out = ShellOutput::default();
    out.hide_until_ready();
    out.feed(b"fish: Unknown command\r\n");
    out.feed(b"> ");
    assert_eq!(out.reveal(), b"fish: Unknown command\r\n> ");
    assert_eq!(out.feed(b"x").output, b"x");
}

#[test]
fn private_markers_preserve_order_even_when_every_byte_arrives_separately() {
    let mut shell = ShellOutput::default();
    shell.hide_until_ready();
    let output = [
        READY,
        b"\x1b]6973;start;1;printf%20%27%25%3B%27\x1b\\",
        b"\x1b]6973;end;garbage\x07",
        b"\x1b]6973;end;17\x07",
        b"\x1b]6973;prompt\x07",
    ]
    .concat();
    let events: Vec<_> = output
        .chunks(1)
        .flat_map(|byte| shell.feed(byte).events)
        .collect();
    assert_eq!(
        events,
        [
            ShellIntegrationEvent::Availability {
                status: ShellIntegrationStatus::Available
            },
            ShellIntegrationEvent::CommandStart {
                command_line: Some("printf '%;'".into())
            },
            ShellIntegrationEvent::CommandEnd { exit_code: 17 },
            ShellIntegrationEvent::PromptStart,
        ]
        .map(TerminalEvent::ShellIntegration)
    );
}
