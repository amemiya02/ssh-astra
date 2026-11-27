use sshastra_core::host_import::{parse_csv, ImportProblem};
use sshastra_core::hosts::{HostAuth, HostStore};
use sshastra_core::ssh_config::{parse, ParseContext};

const CSV: &str = include_str!("fixtures/host-import.csv");

#[test]
fn reads_csv_by_header_and_reports_problem_lines_without_echoing_values() {
    let parsed = parse_csv(CSV);
    let hosts: Vec<_> = parsed
        .hosts
        .iter()
        .map(|host| {
            (
                host.name.as_str(),
                host.address.as_str(),
                host.port,
                host.user.as_str(),
            )
        })
        .collect();
    assert_eq!(
        hosts,
        [
            ("Web, \"Primary\"", "web.example.test", 2201, "deploy"),
            ("Default port", "db.example.test", 22, "ops"),
            ("Web Backup", "backup.example.test", 65535, "ops"),
            ("Two\nlines", "multiline.example.test", 22, "ops"),
            ("Existing", "new.example.test", 22, "new-user"),
        ],
    );
    assert_eq!(parsed.hosts[0].group_path, ["Work", "Production"]);
    assert!(parsed.hosts[1].group_path.is_empty());
    assert!(parsed.issues.iter().all(|issue| issue.dropped));
    let problems: Vec<_> = parsed
        .issues
        .iter()
        .map(|issue| (issue.line, &issue.problem))
        .collect();
    assert_eq!(
        problems,
        [
            (Some(5), &ImportProblem::CsvInvalidPort),
            (
                Some(6),
                &ImportProblem::CsvMissingField { field: "Address" }
            ),
            (Some(7), &ImportProblem::CsvInvalidGroup),
            (Some(9), &ImportProblem::CsvMalformedRecord),
        ],
    );
    assert!(!format!("{parsed:?}").contains("CSV_TEST_"));
}

#[test]
fn accepts_bom_and_windows_newlines_and_reports_missing_required_headers() {
    let parsed = parse_csv("\u{feff}username,NAME,Address\r\nops,Server,192.0.2.1\r\n");
    assert!(parsed.issues.is_empty());
    assert_eq!(parsed.hosts[0].port, 22);

    let invalid = parse_csv("Name,Password\r\nServer,CSV_TEST_PASSWORD\r\n");
    assert!(invalid.hosts.is_empty());
    assert_eq!(invalid.issues.len(), 1);
    assert_eq!(invalid.issues[0].line, Some(1));
    assert_eq!(invalid.issues[0].problem, ImportProblem::CsvHeaders);
    assert!(!format!("{invalid:?}").contains("CSV_TEST_"));
}

#[test]
fn imports_in_one_host_tree_and_reuses_groups_without_touching_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hosts.json");
    let mut store = HostStore::open(&path).unwrap();
    let work = store.create_group("Work", None).unwrap();
    let parsed = parse(
        "Host Existing\n    HostName existing.example.test\n    IdentityFile ~/.ssh/example\n",
        &ParseContext {
            local_user: "local".into(),
        },
        &mut |_| unreachable!(),
    );
    store.import_config(parsed).unwrap();

    let report = store.import_config(parse_csv(CSV)).unwrap();
    assert_eq!(
        report.imported,
        [
            "Web, \"Primary\"",
            "Default port",
            "Web Backup",
            "Two\nlines"
        ]
    );
    assert_eq!(report.skipped, ["Existing"]);
    assert_eq!(report.issues.len(), 4);
    assert!(report.proxy_commands.is_empty());
    assert!(!serde_json::to_string(&report)
        .unwrap()
        .contains("CSV_TEST_"));

    let repeated = store.import_config(parse_csv(CSV)).unwrap();
    assert!(repeated.imported.is_empty());
    assert_eq!(repeated.skipped.len(), 5);

    let saved = HostStore::open(&path).unwrap().tree();
    assert_eq!(saved.groups.len(), 2);
    let production = &saved.groups[1];
    assert_eq!(production.name, "Production");
    assert_eq!(production.parent_id.as_ref(), Some(&work.id));
    let existing = &saved.hosts[0];
    assert_eq!(existing.address, "existing.example.test");
    assert!(matches!(existing.auth, HostAuth::Key { .. }));
    assert!(existing.group_id.is_none());
    assert_eq!(saved.hosts[1].group_id.as_ref(), Some(&production.id));
    assert_eq!(saved.hosts[3].group_id.as_ref(), Some(&production.id));
    assert!(saved.hosts[2].group_id.is_none());
    for host in &saved.hosts[1..] {
        assert_eq!(host.auth, HostAuth::Auto);
        assert!(!host.open_on_startup);
        assert!(!host.forward_agent);
        assert!(host.forwards.is_empty());
        assert!(host.post_login_command.is_none());
    }
    assert!(!std::fs::read_to_string(&path)
        .unwrap()
        .contains("CSV_TEST_"));
}
