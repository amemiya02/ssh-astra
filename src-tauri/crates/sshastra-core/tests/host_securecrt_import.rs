use std::path::Path;

use sshastra_core::host_import::{parse_securecrt, ImportProblem};
use sshastra_core::hosts::{HostAuth, HostStore};

const BUILD: &[u8] = include_bytes!("fixtures/securecrt-build.ini");
const GATEWAY: &[u8] = include_bytes!("fixtures/securecrt-gateway.ini");

#[test]
fn imports_saved_ssh2_sessions_with_nested_groups_and_a_dependent_session() {
    let utf16: Vec<_> = [0xff, 0xfe]
        .into_iter()
        .chain(
            std::str::from_utf8(BUILD)
                .unwrap()
                .replace('\n', "\r\n")
                .encode_utf16()
                .flat_map(u16::to_le_bytes),
        )
        .collect();
    let parsed = parse_securecrt(
        [
            (Path::new("Lab/Production/Build.INI"), utf16.as_slice()),
            (Path::new("Gateways/Primary.ini"), GATEWAY),
            (Path::new("Default.ini"), GATEWAY),
            (Path::new("Lab/__FolderData__.ini"), GATEWAY),
        ],
        "local-user",
    );
    assert_eq!(parsed.hosts.len(), 2);
    assert!(parsed.issues.iter().all(|issue| !issue.dropped));
    assert!(!format!("{parsed:?}").contains("SCRT_TEST_SECRET_"));

    let temp = tempfile::tempdir().unwrap();
    let state = temp.path().join("hosts.json");
    let mut store = HostStore::open(&state).unwrap();
    let lab = store.create_group("Lab", None).unwrap();
    let report = store.import_config(parsed.clone()).unwrap();
    assert_eq!(report.imported, ["Build", "Primary"]);
    assert!(report.skipped.is_empty());
    assert!(report.proxy_commands.is_empty());
    assert_eq!(
        store.import_config(parsed).unwrap().skipped,
        report.imported
    );
    assert!(!serde_json::to_string(&report)
        .unwrap()
        .contains("SCRT_TEST_SECRET_"));

    let store = HostStore::open(&state).unwrap();
    let tree = store.tree();
    let production = tree
        .groups
        .iter()
        .find(|group| group.name == "Production")
        .unwrap();
    assert_eq!(production.parent_id.as_ref(), Some(&lab.id));
    let build = tree.hosts.iter().find(|host| host.name == "Build").unwrap();
    assert_eq!(build.group_id.as_ref(), Some(&production.id));
    assert_eq!(build.address, "build.example.test");
    assert_eq!(build.port, 2222);
    assert_eq!(build.user, "builder");
    assert_eq!(
        build.auth,
        HostAuth::Key {
            identity_file: r"C:\test keys\build.key".into()
        }
    );
    let chain = store.jump_chain(&build.id).unwrap();
    assert_eq!(chain.len(), 2);
    assert_eq!(chain[0].name, "Primary");
    assert_eq!(chain[0].address, "2001:db8::16");
    assert_eq!(chain[0].user, "ops");
    assert_eq!(chain[0].port, 22);
    assert_eq!(
        chain[0].auth,
        HostAuth::Key {
            identity_file: "~/.ssh/example_key".into()
        }
    );
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.entry == "Lab/Production/Build.INI"
            && issue.problem == ImportProblem::SecurecrtCredentials));
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.entry == "Lab/Production/Build.INI"
            && issue.problem == ImportProblem::SecurecrtUnsupportedSettings));
    assert!(!std::fs::read_to_string(state)
        .unwrap()
        .contains("SCRT_TEST_SECRET_"));
}

#[test]
fn reports_unreadable_or_unsupported_settings_without_copying_their_values() {
    let valid = "S:\"Protocol Name\"=SSH2\nS:\"Hostname\"=host.example.test\n";
    let with = |setting| format!("{valid}{setting}\n");
    let cases = [
        ("Bad port.ini", with("D:\"[SSH2] Port\"=SCRT_TEST_SECRET_PORT"), ImportProblem::SecurecrtInvalidPort),
        ("Port overflow.ini", with("D:\"[SSH2] Port\"=00010000"), ImportProblem::SecurecrtInvalidPort),
        ("Port zero.ini", with("D:\"[SSH2] Port\"=00000000"), ImportProblem::SecurecrtInvalidPort),
        ("Telnet.ini", "S:\"Protocol Name\"=TELNET\n".into(), ImportProblem::SecurecrtUnsupportedSession),
        ("Firewall.ini", with("S:\"Firewall Name\"=SCRT_TEST_SECRET_FIREWALL"), ImportProblem::SecurecrtUnsupportedFirewall),
        ("Inline credentials.ini", "S:\"Protocol Name\"=SSH2\nS:\"Hostname\"=user:SCRT_TEST_SECRET_INLINE@host.example.test\n".into(), ImportProblem::SecurecrtFile),
        ("Truncated.ini", with("Z:\"Logon Actions\"=00000002\nSCRT_TEST_SECRET_LOGON"), ImportProblem::SecurecrtFile),
        ("../SCRT_TEST_SECRET_OUTSIDE.ini", valid.into(), ImportProblem::SecurecrtFile),
    ];
    let parsed = parse_securecrt(
        cases
            .iter()
            .map(|(path, body, _)| (Path::new(path), body.as_bytes())),
        "local-user",
    );
    assert!(parsed.hosts.is_empty());
    assert_eq!(parsed.issues.len(), cases.len());
    for (issue, (_, _, expected)) in parsed.issues.iter().zip(cases) {
        assert!(issue.dropped);
        assert_eq!(issue.problem, expected);
    }
    assert!(!format!("{parsed:?}").contains("SCRT_TEST_SECRET_"));
}

#[test]
fn unavailable_or_ambiguous_jump_paths_do_not_import_as_direct_connections() {
    let gateway = |target| {
        format!(
            "S:\"Protocol Name\"=SSH2\nS:\"Hostname\"=route.example.test\nS:\"Firewall Name\"=Session:{target}\n"
        )
    };
    let files = [
        ("A.ini", gateway("B")),
        ("B.ini", gateway("A")),
        ("Needs B.ini", gateway("B")),
        ("Missing.ini", gateway("../SCRT_TEST_SECRET_ROUTE")),
        ("Ambiguous.ini", gateway("Second/Shared")),
    ];
    let parsed = parse_securecrt(
        files
            .iter()
            .map(|(path, body)| (Path::new(path), body.as_bytes()))
            .chain([
                (Path::new("First/Shared.ini"), GATEWAY),
                (Path::new("Second/Shared.ini"), GATEWAY),
            ]),
        "local-user",
    );
    assert_eq!(parsed.hosts.len(), 2);
    assert!(parsed.hosts.iter().all(|host| host.name == "Shared"));
    assert_eq!(parsed.issues.len(), files.len());
    for (issue, (expected_entry, _)) in parsed.issues.iter().zip(files) {
        assert_eq!(issue.entry, expected_entry);
        assert!(issue.dropped);
        assert_eq!(issue.problem, ImportProblem::SecurecrtJumpHostUnavailable);
    }
    assert!(!format!("{parsed:?}").contains("SCRT_TEST_SECRET_"));
}

#[test]
fn global_and_securecrt_specific_key_paths_require_choosing_a_private_key() {
    let valid = "S:\"Protocol Name\"=SSH2\nS:\"Hostname\"=host.example.test\n";
    let global =
        format!("{valid}D:\"Use Global Public Key\"=00000001\nS:\"Identity Filename V2\"=/old/key");
    let token = format!("{valid}S:\"Identity Filename V2\"=${{VDS_CONFIG_PATH}}/test_key");
    let parsed = parse_securecrt(
        [
            (Path::new("Global key.ini"), global.as_bytes()),
            (Path::new("Substitution.ini"), token.as_bytes()),
        ],
        "local-user",
    );
    assert_eq!(parsed.hosts.len(), 2);
    assert!(parsed
        .hosts
        .iter()
        .all(|host| host.identity_file.is_none() && host.user == "local-user" && host.port == 22));
    for entry in ["Global key.ini", "Substitution.ini"] {
        let issues: Vec<_> = parsed
            .issues
            .iter()
            .filter(|issue| issue.entry == entry)
            .collect();
        assert_eq!(issues.len(), 2);
        assert!(issues.iter().all(|issue| !issue.dropped));
        assert_eq!(issues[0].problem, ImportProblem::SecurecrtKeyPath);
        assert_eq!(issues[1].problem, ImportProblem::SecurecrtDefaultUser);
    }
}
