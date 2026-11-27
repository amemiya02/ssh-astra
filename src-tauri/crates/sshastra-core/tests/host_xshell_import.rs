use std::path::Path;

use sshastra_core::host_import::{parse_xshell, ImportProblem};
use sshastra_core::hosts::{HostAuth, HostStore};

const BUILD: &[u8] = include_bytes!("fixtures/xshell-build.xsh");
const LOCAL: &[u8] = include_bytes!("fixtures/xshell-local.xsh");

#[test]
fn maps_connection_settings_and_nested_groups_through_the_shared_import() {
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
    let parsed = parse_xshell(
        [
            (
                Path::new("Work/Production/Build server.XSH"),
                utf16.as_slice(),
            ),
            (Path::new("Files.xsh"), LOCAL),
        ],
        "local-user",
    );
    assert_eq!(parsed.hosts.len(), 3);
    assert!(!format!("{parsed:?}").contains("XSH_TEST_SECRET_"));

    let temp = tempfile::tempdir().unwrap();
    let state = temp.path().join("hosts.json");
    let mut store = HostStore::open(&state).unwrap();
    let work = store.create_group("Work", None).unwrap();
    let report = store.import_config(parsed.clone()).unwrap();
    assert_eq!(report.imported.len(), 3);
    assert!(report.skipped.is_empty());
    assert!(report.proxy_commands.is_empty());
    assert_eq!(
        store.import_config(parsed).unwrap().skipped,
        report.imported
    );
    assert!(!serde_json::to_string(&report)
        .unwrap()
        .contains("XSH_TEST_SECRET_"));

    let store = HostStore::open(&state).unwrap();
    let tree = store.tree();
    let production = tree
        .groups
        .iter()
        .find(|group| group.name == "Production")
        .unwrap();
    assert_eq!(production.parent_id.as_ref(), Some(&work.id));
    let build = tree
        .hosts
        .iter()
        .find(|host| host.name == "Build server")
        .unwrap();
    assert_eq!(build.group_id.as_ref(), Some(&production.id));
    assert_eq!(build.address, "build.example.test");
    assert_eq!(build.user, "builder");
    assert_eq!(build.port, 2222);
    assert_eq!(
        build.auth,
        HostAuth::Key {
            identity_file: r"C:\test-keys\build.key".into()
        }
    );
    let chain = store.jump_chain(&build.id).unwrap();
    assert_eq!(chain.len(), 2);
    assert_eq!(chain[0].group_id, build.group_id);
    assert_eq!(chain[0].address, "2001:db8::16");
    assert_eq!(chain[0].user, "ops");
    assert_eq!(chain[0].port, 2202);
    let files = tree.hosts.iter().find(|host| host.name == "Files").unwrap();
    assert!(files.group_id.is_none());
    assert_eq!(files.port, 22);
    assert_eq!(files.user, "files");
    assert_eq!(files.auth, HostAuth::Auto);
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.entry == "Work/Production/Build server.XSH"
            && issue.problem == ImportProblem::XshellCredentials
            && !issue.dropped));
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.problem == ImportProblem::XshellUnsupportedSettings));
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.problem == ImportProblem::XshellKeyPath));
    assert!(!std::fs::read_to_string(state)
        .unwrap()
        .contains("XSH_TEST_SECRET_"));
}

#[test]
fn drops_unsupported_sessions_and_unresolved_routes_without_reporting_values() {
    let invalid_port =
        b"[CONNECTION]\nProtocol=SSH\nHost=build.example.test\nPort=XSH_TEST_SECRET_PORT\n";
    let inline_secret =
        b"[CONNECTION]\nProtocol=SSH\nHost=user:XSH_TEST_SECRET_INLINE@build.example.test\n";
    let telnet = b"[CONNECTION]\nProtocol=TELNET\nHost=build.example.test\n";
    let named_proxy = b"[CONNECTION]\nProtocol=SSH\nHost=build.example.test\n[CONNECTION:PROXY]\nProxy=XSH_TEST_SECRET_PROFILE\n";
    let invalid_jump = b"[CONNECTION]\nProtocol=SSH\nHost=build.example.test\n[CONNECTION:PROXY]\nType=JUMPHOST\nHost=jump.example.test\nPort=0\n";
    let external_route = b"[CONNECTION]\nProtocol=SSH\nHost=build.example.test\n[CONNECTION:PROXY]\nType=JUMPHOST\nHost=jump.example.test\nSessionFile=../XSH_TEST_SECRET_PATH.xsh\n";
    let parsed = parse_xshell(
        [
            (Path::new("Invalid port.xsh"), invalid_port.as_slice()),
            (
                Path::new("Inline credentials.xsh"),
                inline_secret.as_slice(),
            ),
            (Path::new("Other protocol.xsh"), telnet.as_slice()),
            (Path::new("Named profile.xsh"), named_proxy.as_slice()),
            (Path::new("Invalid Jump host.xsh"), invalid_jump.as_slice()),
            (Path::new("External session.xsh"), external_route.as_slice()),
            (Path::new("../XSH_TEST_SECRET_OUTSIDE.xsh"), LOCAL),
        ],
        "local-user",
    );
    assert!(parsed.hosts.is_empty());
    assert_eq!(parsed.issues.len(), 7);
    assert!(parsed.issues.iter().all(|issue| issue.dropped));
    assert!(!format!("{parsed:?}").contains("XSH_TEST_SECRET_"));
    assert_eq!(
        parsed
            .issues
            .into_iter()
            .map(|issue| issue.problem)
            .collect::<Vec<_>>(),
        [
            ImportProblem::XshellInvalidPort,
            ImportProblem::XshellFile,
            ImportProblem::XshellUnsupportedSession,
            ImportProblem::XshellUnsupportedProxy,
            ImportProblem::XshellInvalidJumpHost,
            ImportProblem::XshellUnsupportedProxy,
            ImportProblem::XshellFile,
        ]
    );
}

#[test]
fn uses_the_supplied_default_username_and_retains_an_explicit_home_key_path() {
    let session = b"[CONNECTION]\nProtocol=ssh\nHost=[2001:db8::8]\n[CONNECTION:AUTHENTICATION]\nUserKey=~/.ssh/test_key\n";
    let parsed = parse_xshell(
        [(Path::new("Direct.xsh"), session.as_slice())],
        "local-user",
    );
    assert_eq!(parsed.hosts[0].address, "2001:db8::8");
    assert_eq!(parsed.hosts[0].user, "local-user");
    assert_eq!(
        parsed.hosts[0].identity_file.as_deref(),
        Some(Path::new("~/.ssh/test_key"))
    );
    assert_eq!(parsed.issues.len(), 1);
    assert_eq!(parsed.issues[0].problem, ImportProblem::XshellDefaultUser);
    assert!(!parsed.issues[0].dropped);
}
