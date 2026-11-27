use std::path::PathBuf;

use sshastra_core::host_import::{parse_putty, ImportProblem};
use sshastra_core::hosts::{HostAuth, HostStore};

const PUTTY: &str = include_str!("fixtures/putty-sessions.reg");

#[test]
fn reads_registry_sessions_and_links_their_jump_hosts_without_credentials() {
    let windows_export: Vec<u8> = "\u{feff}"
        .encode_utf16()
        .chain(PUTTY.replace('\n', "\r\n").encode_utf16())
        .flat_map(u16::to_le_bytes)
        .collect();
    let parsed = parse_putty(&windows_export, "local");
    let host = |name: &str| parsed.hosts.iter().find(|h| h.name == name).unwrap();
    let web = host("Web %\\ 雲");
    assert_eq!(web.address, "web.example.test");
    assert_eq!(web.port, 2201);
    assert_eq!(web.user, "deploy");
    assert_eq!(web.group_path, ["Work", "North America"]);
    assert_eq!(
        web.identity_file,
        Some(PathBuf::from(r#"C:\Test Keys\web "A".ppk"#))
    );
    assert_eq!(web.keepalive_seconds, Some(70));
    assert_eq!(web.jump_host.as_deref(), Some("Bastion Host"));
    let other = host("Other Web");
    assert_eq!(other.address, "2001:db8::1");
    let other_jump = host(other.jump_host.as_deref().unwrap());
    assert_eq!(other_jump.user, "audit");
    assert_eq!(
        other_jump.identity_file,
        Some(PathBuf::from(r"C:\Keys\jump.ppk"))
    );
    let jump = host("Bastion Host");
    assert_eq!(jump.user, "staging");
    assert_eq!(other_jump.jump_host, jump.jump_host);
    let edge = host(jump.jump_host.as_deref().unwrap());
    assert_eq!(edge.address, "edge.example.test");
    assert_eq!(edge.port, 2222);
    assert_eq!(edge.user, "edge");
    assert_eq!(
        edge.identity_file,
        Some(PathBuf::from(r"C:\Keys\default.ppk"))
    );
    let flat = host("A/B");
    assert!(flat.group_path.is_empty());
    assert_eq!(flat.port, 22);
    assert_eq!(flat.user, "local");
    assert!(host("Café").proxy_command.is_none());
    assert_eq!(parsed.hosts.len(), 7);
    assert!(parsed
        .issues
        .iter()
        .any(|issue| issue.problem == ImportProblem::PuttyCredentials && !issue.dropped));
    assert!(parsed.issues.iter().any(|issue| issue.entry == "Café" && matches!(&issue.problem,
        ImportProblem::PuttyUnsupportedOptions { options } if options.contains("ProxyMethod") && options.contains("ProxyTelnetCommand")
    )));
    assert!(parsed.issues.iter().any(|issue| issue.entry == "Bad Port"
        && issue.dropped
        && issue.problem
            == ImportProblem::PuttyInvalidOption {
                option: "PortNumber"
            }));
    assert!(parsed.issues.iter().any(|issue| issue.entry == "Old Telnet"
        && issue.dropped
        && issue.problem == ImportProblem::PuttyUnsupportedProtocol));
    assert!(!format!("{parsed:?}").contains("PUTTY_TEST_"));
}

#[test]
fn saves_groups_keys_and_jump_chain_through_host_store_without_exporting_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hosts.json");
    let export = dir.path().join("export.json");
    let mut store = HostStore::open(&path).unwrap();
    let work = store.create_group("Work", None).unwrap();
    let report = store
        .import_config(parse_putty(PUTTY.as_bytes(), "local"))
        .unwrap();
    assert_eq!(report.imported.len(), 7);
    assert!(report.proxy_commands.is_empty());
    assert!(!serde_json::to_string(&report)
        .unwrap()
        .contains("PUTTY_TEST_"));

    let store = HostStore::open(&path).unwrap();
    let tree = store.tree();
    assert_eq!(tree.groups.len(), 2);
    assert_eq!(tree.groups[1].parent_id.as_ref(), Some(&work.id));
    let web = tree.hosts.iter().find(|h| h.name == "Web %\\ 雲").unwrap();
    assert_eq!(web.group_id.as_ref(), Some(&tree.groups[1].id));
    assert!(matches!(&web.auth, HostAuth::Key { identity_file }
        if identity_file == &PathBuf::from(r#"C:\Test Keys\web "A".ppk"#)));
    let jumps: Vec<_> = store
        .jump_chain(&web.id)
        .unwrap()
        .into_iter()
        .map(|h| h.address)
        .collect();
    assert_eq!(
        jumps,
        [
            "edge.example.test",
            "bastion.example.test",
            "web.example.test"
        ]
    );
    store.export_to(&export).unwrap();
    for file in [path, export] {
        assert!(!std::fs::read_to_string(file)
            .unwrap()
            .contains("PUTTY_TEST_"));
    }
}

#[test]
fn rejects_malformed_exports_and_skips_unusable_jump_routes() {
    let invalid = parse_putty(b"PUTTY_TEST_MALFORMED", "local");
    assert!(invalid.hosts.is_empty());
    assert_eq!(invalid.issues[0].problem, ImportProblem::PuttyFile);
    assert_eq!(invalid.issues[0].line, Some(1));
    assert!(!format!("{invalid:?}").contains("PUTTY_TEST_"));

    let parsed = parse_putty(
        br#"REGEDIT4

[hkey_current_user\software\simontatham\putty\sessions\Vault]
"hostname"="vault.example.test"
"username"="ops"
"proxymethod"=dword:00000006
"proxyhost"="Loop"

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\Loop]
"HostName"="loop.example.test"
"ProxyMethod"=dword:00000006
"ProxyHost"="Loop"

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\Bad%ZZ]
"HostName"="bad.example.test"

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\Web]
"HostName"="web.example.test:3333"
"UserName"="ops"
"PortNumber"=dword:00000016
"ProxyMethod"=dword:00000006
"ProxyHost"="gateway.example.test"
"ProxyPort"=dword:000008ad

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\Database]
"HostName"="db.example.test"
"UserName"="ops"
"ProxyMethod"=dword:00000006
"ProxyHost"="gateway.example.test"
"ProxyPort"=dword:000008ae
"#,
        "local",
    );
    assert!(parsed.issues.iter().any(|issue| issue.entry == "Loop"
        && issue.dropped
        && issue.problem == ImportProblem::JumpHostLoop));
    assert!(parsed.issues.iter().any(|issue| issue.entry == "Vault"
        && issue.dropped
        && matches!(&issue.problem, ImportProblem::JumpHostUnavailable { hop } if hop == "Loop")));
    assert!(parsed.issues.iter().any(|issue| issue.line.is_some()
        && issue.dropped
        && issue.problem == ImportProblem::PuttySessionName));
    assert_eq!(parsed.hosts.len(), 4);
    let web = parsed.hosts.iter().find(|host| host.name == "Web").unwrap();
    assert_eq!(web.address, "web.example.test");
    assert_eq!(web.port, 22);
    let db = parsed
        .hosts
        .iter()
        .find(|host| host.name == "Database")
        .unwrap();
    let jump_port = |name: Option<&str>| {
        parsed
            .hosts
            .iter()
            .find(|host| Some(host.name.as_str()) == name)
            .unwrap()
            .port
    };
    assert_eq!(jump_port(web.jump_host.as_deref()), 2221);
    assert_eq!(jump_port(db.jump_host.as_deref()), 2222);
}
