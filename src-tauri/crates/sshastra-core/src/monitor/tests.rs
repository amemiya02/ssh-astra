use super::*;

const FIRST: &[u8] = b"snapshot
cpu 10 0 20 70 0 0 0 0
cores 4
load 0.21 0.14 0.09
memory 8192 3072
swap 2048 1280
net eth0 1000 6000
net lo 50 60
uptime 30.00
disk 6000 1234 /
disk 9000 3456 /data/project files
end
";

const SECOND: &[u8] = b"snapshot
cpu 20 0 30 100 0 0 0 0
cores 4
load 0.31 0.14 0.09
memory 8192 4096
swap 2048 1280
net eth0 1520 6500
net eth1 400 500
uptime 32.00
disk 6000 1234 /
end
";

fn parsed(frame: &[u8]) -> Sample {
    match parse_frame(frame).unwrap() {
        Frame::Snapshot(sample) => sample,
        Frame::Unsupported => panic!("expected snapshot"),
    }
}

#[test]
fn parses_current_resources_and_calculates_rates_from_consecutive_samples() {
    let first = parsed(FIRST);
    let initial = first.snapshot(None);
    assert_eq!(initial.cores, 4);
    assert_eq!(initial.cpu_percent, None);
    assert_eq!(initial.load, [0.21, 0.14, 0.09]);
    assert_eq!(
        initial.memory,
        Usage {
            used: 5_242_880,
            total: 8_388_608
        }
    );
    assert_eq!(
        initial.swap,
        Usage {
            used: 786_432,
            total: 2_097_152
        }
    );
    assert_eq!(initial.disks[1].mount, "/data/project files");
    assert_eq!(
        initial.disks[1].usage,
        Usage {
            used: 3_538_944,
            total: 9_216_000
        }
    );
    assert_eq!(initial.network.len(), 1);
    assert_eq!(initial.network[0].receive_rate, None);

    let next = parsed(SECOND).snapshot(Some(&first));
    assert_eq!(next.uptime_seconds, 32.0);
    assert_eq!(next.cpu_percent, Some(40.0));
    assert_eq!(next.network[0].receive_rate, Some(260.0));
    assert_eq!(next.network[0].send_rate, Some(250.0));
    assert_eq!(next.network[1].receive_rate, None);
}

#[test]
fn treats_missing_proc_as_unsupported_and_rejects_bad_or_excessive_payloads() {
    assert!(matches!(
        parse_frame(b"unsupported\nend\n"),
        Some(Frame::Unsupported)
    ));
    assert!(parse_frame(b"unsupported\nextra\nend\n").is_none());
    assert!(parse_frame(&FIRST[..FIRST.len() - 2]).is_none());
    for replacement in [
        ("cores 4", "cores 0"),
        ("cores 4", "cores 4\ncores 4"),
        ("memory 8192 3072", "memory 8192 8193"),
        ("memory 8192 3072", "memory 18446744073709551615 3072"),
        ("uptime 30.00", "uptime NaN"),
        ("disk 6000 1234 /", "disk 6000 1234 \x1b[H/"),
        (
            "net eth0 1000 6000",
            "net eth0 1000 6000\nnet eth0 1000 6000",
        ),
    ] {
        let frame = std::str::from_utf8(FIRST)
            .unwrap()
            .replace(replacement.0, replacement.1);
        assert!(parse_frame(frame.as_bytes()).is_none(), "{frame}");
    }
    assert!(parse_frame(&vec![b' '; MAX_FRAME_BYTES + 1]).is_none());
}

#[test]
fn uses_no_rate_after_a_counter_resets_or_uptime_restarts() {
    let first = parsed(FIRST);
    let reset = std::str::from_utf8(SECOND)
        .unwrap()
        .replace("eth0 1520 6500", "eth0 123 500");
    let snapshot = parsed(reset.as_bytes()).snapshot(Some(&first));
    assert_eq!(snapshot.network[0].receive_rate, None);
    assert_eq!(snapshot.network[0].send_rate, None);

    let restarted = std::str::from_utf8(SECOND)
        .unwrap()
        .replace("uptime 32.00", "uptime 1.00");
    let snapshot = parsed(restarted.as_bytes()).snapshot(Some(&first));
    assert_eq!(snapshot.network[0].receive_rate, None);
    assert_eq!(snapshot.cpu_percent, None);
}
