use std::path::Path;

use sshastra_core::host_import::{parse_mobaxterm, ImportProblem};
use sshastra_core::hosts::{HostAuth, HostStore};

const SESSIONS: &[u8] = include_bytes!("fixtures/mobaxterm-sessions.mxtsessions");

#[test]
fn parses_ssh_sessions_groups_keys_and_ordered_gateways() {
    let parsed = parse_mobaxterm(SESSIONS, "local");
    assert_eq!(parsed.hosts.len(), 4);
    let direct = &parsed.hosts[0];
    assert_eq!(direct.name, "Direct");
    assert_eq!(direct.address, "direct.example.test");
    assert_eq!(direct.port, 22);
    assert_eq!(direct.user, "ops");
    assert!(direct.group_path.is_empty());

    let build = &parsed.hosts[1];
    assert_eq!(build.name, "Build server");
    assert_eq!(build.address, "build.example.test");
    assert_eq!(build.port, 2202);
    assert_eq!(build.user, "builder");
    assert_eq!(build.group_path, ["Work", "Production"]);
    assert_eq!(
        build.identity_file.as_deref(),
        Some(Path::new("~/.ssh/build.key"))
    );

    let outer = &parsed.hosts[2];
    assert_eq!(outer.address, "outer.example.test");
    assert_eq!(outer.port, 2223);
    assert_eq!(outer.user, "gateway");
    assert_eq!(outer.group_path, build.group_path);
    assert_eq!(
        outer.identity_file.as_deref(),
        Some(Path::new(r"D:\test-keys\gateway.ppk"))
    );
    assert!(outer.jump_host.is_none());

    let inner = &parsed.hosts[3];
    assert_eq!(inner.address, "2001:db8::16");
    assert_eq!(inner.port, 22);
    assert_eq!(inner.user, "route");
    assert!(inner.identity_file.is_none());
    assert_eq!(inner.jump_host.as_ref(), Some(&outer.name));
    assert_eq!(build.jump_host.as_ref(), Some(&inner.name));
}

#[test]
fn reports_unsupported_and_invalid_entries_without_echoing_passwords() {
    let parsed = parse_mobaxterm(SESSIONS, "local");
    let issues: Vec<_> = parsed
        .issues
        .iter()
        .map(|issue| (issue.line, issue.dropped, &issue.problem))
        .collect();
    assert_eq!(
        issues,
        [
            (Some(8), false, &ImportProblem::MobaxtermUnsupportedSettings),
            (Some(10), true, &ImportProblem::MobaxtermUnsupportedSession),
            (Some(11), true, &ImportProblem::MobaxtermInvalidPort),
            (Some(12), true, &ImportProblem::MobaxtermInvalidGateway),
            (Some(13), true, &ImportProblem::MobaxtermSession),
            (Some(17), true, &ImportProblem::MobaxtermInvalidGroup),
        ]
    );
    assert!(parsed.issues.iter().all(|issue| issue.entry.is_empty()));
    assert!(!format!("{parsed:?}").contains("MOBA_TEST_SECRET_"));
    assert!(parsed.hosts.iter().all(|host| host.proxy_command.is_none()));
}

#[test]
fn accepts_windows_text_and_single_exports_and_reports_missing_username() {
    let parsed = parse_mobaxterm(
        b"[Bookmarks]\r\nSubRep=Caf\xe9\r\nCaf\xe9 \x80=#109#0%db.example.test%22%ops\r\n",
        "local",
    );
    assert!(parsed.issues.is_empty());
    assert_eq!(parsed.hosts[0].name, "Café €");
    assert_eq!(parsed.hosts[0].group_path, ["Café"]);

    let single = "\u{feff}Build=#109#0%build.example.test%22%<default>\r\n";
    let parsed = parse_mobaxterm(single.as_bytes(), "local");
    assert_eq!(parsed.hosts[0].user, "local");
    assert!(parsed.hosts[0].group_path.is_empty());
    assert_eq!(
        parsed.issues[0].problem,
        ImportProblem::MobaxtermDefaultUser
    );
    assert!(!parsed.issues[0].dropped);

    let invalid = parse_mobaxterm(b"[Passwords]\nMOBA_TEST_SECRET_VALUE=ignored\n", "local");
    assert!(invalid.hosts.is_empty());
    assert_eq!(invalid.issues[0].problem, ImportProblem::MobaxtermFile);
    assert!(!format!("{invalid:?}").contains("MOBA_TEST_SECRET_"));
}

#[test]
fn reports_installation_relative_key_paths_without_saving_them() {
    let row = br"Host=#109#0%host.example.test%22%ops%%%%%%%%%%%_CurrentDrive_\test-keys\host.key";
    let parsed = parse_mobaxterm(row, "local");
    assert!(parsed.hosts[0].identity_file.is_none());
    assert_eq!(parsed.issues.len(), 1);
    assert_eq!(parsed.issues[0].problem, ImportProblem::MobaxtermKeyPath);
    assert!(!parsed.issues[0].dropped);
    assert!(!format!("{parsed:?}").contains("test-keys"));
}

#[test]
fn saves_grouped_ssh_hosts_through_the_shared_import_and_resolves_gateway_ids() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hosts.json");
    let mut store = HostStore::open(&path).unwrap();
    let work = store.create_group("Work", None).unwrap();

    let report = store
        .import_config(parse_mobaxterm(SESSIONS, "local"))
        .unwrap();
    assert_eq!(report.imported.len(), 4);
    assert!(report.skipped.is_empty());
    assert!(report.proxy_commands.is_empty());
    assert!(!serde_json::to_string(&report)
        .unwrap()
        .contains("MOBA_TEST_SECRET_"));

    let repeated = store
        .import_config(parse_mobaxterm(SESSIONS, "local"))
        .unwrap();
    assert!(repeated.imported.is_empty());
    assert_eq!(repeated.skipped, report.imported);

    let store = HostStore::open(&path).unwrap();
    let tree = store.tree();
    assert_eq!(tree.groups.len(), 2);
    let prod = &tree.groups[1];
    assert_eq!(prod.name, "Production");
    assert_eq!(prod.parent_id.as_ref(), Some(&work.id));
    assert!(tree.hosts[0].group_id.is_none());
    for host in &tree.hosts[1..] {
        assert_eq!(host.group_id.as_ref(), Some(&prod.id));
        assert!(!host.forward_agent);
        assert!(host.post_login_command.is_none());
    }
    let build = &tree.hosts[1];
    assert_eq!(
        build.auth,
        HostAuth::Key {
            identity_file: "~/.ssh/build.key".into()
        }
    );
    let chain = store.jump_chain(&build.id).unwrap();
    let addresses: Vec<_> = chain.iter().map(|host| host.address.as_str()).collect();
    assert_eq!(
        addresses,
        ["outer.example.test", "2001:db8::16", "build.example.test"]
    );
    assert!(!std::fs::read_to_string(path)
        .unwrap()
        .contains("MOBA_TEST_SECRET_"));
}
