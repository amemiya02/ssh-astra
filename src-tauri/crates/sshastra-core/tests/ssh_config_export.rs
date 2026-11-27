use std::fs;
use std::path::Path;
use std::process::Command;

use serde_json::json;
use sshastra_core::hosts::{HostDraft, HostStore};
use sshastra_core::ssh::ConnectionSettings;
use sshastra_core::ssh_config_export::{generate, ConfigExport, ExportIssue, INCLUDE_LINE};

fn host(name: &str, address: &str) -> HostDraft {
    serde_json::from_value(json!({
        "name": name, "address": address, "port": 2222, "user": "deploy",
        "auth": {"type": "key", "identityFile": "~/private keys/build key"}
    }))
    .unwrap()
}

#[test]
fn a_fragment_can_be_read_by_openssh_without_connecting() {
    let dir = tempfile::tempdir().unwrap();
    let mut hosts = HostStore::open(dir.path().join("hosts.json")).unwrap();
    let edge = hosts.upsert(None, host("Edge 1", "192.0.2.1")).unwrap();
    let mut middle = host("Middle", "192.0.2.2");
    middle.jump_host = Some(edge.id);
    let middle = hosts.upsert(None, middle).unwrap();
    let mut app = host(" Build / API ", "2001:db8::10");
    app.jump_host = Some(middle.id);
    app.keepalive_seconds = Some(0);
    app.identities_only = true;
    app.forward_agent = true;
    let app = hosts.upsert(None, app).unwrap();
    for fields in [
        json!({"type":"local","bindAddress":"::1","bindPort":3000,"remoteHost":"2001:db8::20","remotePort":80}),
        json!({"type":"remote","bindAddress":"localhost","bindPort":3001,"localHost":"127.0.0.1","localPort":81}),
        json!({"type":"dynamic","bindAddress":"127.0.0.1","bindPort":3002}),
        json!({"type":"http","bindAddress":"127.0.0.1","bindPort":3003}),
    ] {
        let mut fields = fields.as_object().unwrap().clone();
        fields.insert("autoStart".into(), true.into());
        hosts
            .save_forward(
                &app.id,
                None,
                serde_json::from_value(fields.into()).unwrap(),
            )
            .unwrap();
    }
    hosts
        .save_forward(
            &app.id,
            None,
            serde_json::from_value(json!({
                "type":"dynamic","bindAddress":"127.0.0.1","bindPort":3004,"autoStart":false
            }))
            .unwrap(),
        )
        .unwrap();

    let fragment = generate(
        hosts.list(),
        &Default::default(),
        &ConnectionSettings::default(),
    );
    assert_eq!(fragment.report.aliases, ["build-api", "edge-1", "middle"]);
    assert!(fragment
        .report
        .issues
        .iter()
        .any(|issue| issue.reason == ExportIssue::HttpForward));
    assert!(fragment
        .report
        .issues
        .iter()
        .any(|issue| issue.reason == ExportIssue::ManualForward));
    assert!(fragment
        .text
        .contains("    LocalForward [::1]:3000 [2001:db8::20]:80\n"));
    assert!(fragment
        .text
        .contains("    RemoteForward localhost:3001 127.0.0.1:81\n"));
    assert!(fragment
        .text
        .contains("    DynamicForward 127.0.0.1:3002\n"));
    assert!(!fragment.text.contains("3003"));
    assert!(!fragment.text.contains("3004"));

    let path = dir.path().join("generated.conf");
    fs::write(&path, fragment.text).unwrap();
    let output = ssh_config(&path, "build-api");
    for expected in [
        "hostname 2001:db8::10",
        "port 2222",
        "user deploy",
        "proxyjump middle",
        "identityfile ~/private keys/build key",
        "identitiesonly yes",
        "forwardagent yes",
        "serveraliveinterval 0",
    ] {
        assert!(
            output.lines().any(|line| line == expected),
            "missing {expected} in {output}"
        );
    }
    assert!(ssh_config(&path, "middle")
        .lines()
        .any(|line| line == "proxyjump edge-1"));
}

fn ssh_config(path: &Path, alias: &str) -> String {
    let result = Command::new("ssh")
        .args(["-G", "-T", "-F"])
        .arg(path)
        .arg(alias)
        .output()
        .expect("OpenSSH is required for this test");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap()
}

#[test]
fn setup_only_changes_the_user_file_after_a_current_preview_and_only_once() {
    let dir = tempfile::tempdir().unwrap();
    let export = ConfigExport::new(dir.path().into());
    let ssh = dir.path().join(".ssh");
    let config = ssh.join("config");
    let fragment = ssh.join("ssh-astra.conf");
    let original =
        b"# user comments\r\nHost own\r\n  HostName old.example\r\n\r\nHost *\r\n  Compression yes";
    let settings = ConnectionSettings::default();
    let mut hosts = HostStore::open(dir.path().join("hosts.json")).unwrap();
    let saved = hosts
        .upsert(None, host("Our Example", "192.0.2.10"))
        .unwrap();

    drop(export.preview().unwrap());
    assert!(
        !ssh.exists(),
        "preview and cancellation do not even create .ssh"
    );

    let from_missing_config = export.preview().unwrap();
    fs::create_dir(&ssh).unwrap();
    fs::write(&config, original).unwrap();
    assert!(export
        .enable(from_missing_config, hosts.list(), &settings)
        .is_err());
    assert!(!fragment.exists());
    assert_eq!(fs::read(&config).unwrap(), original);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&config, fs::Permissions::from_mode(0o640)).unwrap();
    }
    let plan = export.preview().unwrap();
    assert!(plan.adds_include());
    export.enable(plan, hosts.list(), &settings).unwrap();
    let expected = [INCLUDE_LINE.as_bytes(), b"\r\n", original].concat();
    assert_eq!(fs::read(&config).unwrap(), expected);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&config).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(
            fs::metadata(&fragment).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    hosts
        .upsert(Some(saved.id), host("Our Example", "192.0.2.11"))
        .unwrap();
    assert_eq!(
        export.refresh(hosts.list(), &settings).unwrap().aliases,
        ["our-example"]
    );
    assert!(fs::read_to_string(&fragment)
        .unwrap()
        .contains("192.0.2.11"));
    assert_eq!(fs::read(&config).unwrap(), expected);

    export.disable().unwrap();
    assert!(!fs::read_to_string(&fragment).unwrap().contains("Host "));
    assert_eq!(fs::read(&config).unwrap(), expected);
    let plan = export.preview().unwrap();
    assert!(!plan.adds_include());
    export.enable(plan, hosts.list(), &settings).unwrap();
    assert_eq!(fs::read(&config).unwrap(), expected);
}

#[test]
fn a_stale_preview_and_an_unowned_fragment_preserve_the_users_files() {
    let dir = tempfile::tempdir().unwrap();
    let export = ConfigExport::new(dir.path().into());
    let ssh = dir.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    let config = ssh.join("config");
    let fragment = ssh.join("ssh-astra.conf");
    fs::write(&config, "# original\nHost own\n").unwrap();
    let plan = export.preview().unwrap();
    fs::write(&config, "# edited elsewhere\nHost own\n").unwrap();
    assert!(export
        .enable(plan, &[], &ConnectionSettings::default())
        .is_err());
    assert_eq!(
        fs::read_to_string(&config).unwrap(),
        "# edited elsewhere\nHost own\n"
    );
    assert!(!fragment.exists());

    fs::write(&fragment, "Host user-owned\n").unwrap();
    assert!(export.preview().is_err());
    assert!(export.disable().is_err());
    assert_eq!(fs::read_to_string(&fragment).unwrap(), "Host user-owned\n");
}

#[test]
fn an_include_under_a_specific_host_is_never_duplicated() {
    let dir = tempfile::tempdir().unwrap();
    let ssh = dir.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    let config = "Host private\n  Include ssh-astra.conf\n";
    fs::write(ssh.join("config"), config).unwrap();
    let export = ConfigExport::new(dir.path().into());
    assert!(export.preview().is_err());
    assert!(!ssh.join("ssh-astra.conf").exists());
    assert_eq!(fs::read_to_string(ssh.join("config")).unwrap(), config);
}

#[test]
fn user_aliases_from_nested_includes_win_even_when_their_fields_cannot_be_imported() {
    let dir = tempfile::tempdir().unwrap();
    let ssh = dir.path().join(".ssh");
    fs::create_dir_all(ssh.join("profiles/release")).unwrap();
    fs::write(
        ssh.join("config"),
        "Include 'profiles/*/team config'\nHost *\n  ServerAliveInterval 10\n",
    )
    .unwrap();
    fs::write(
        ssh.join("profiles/release/team config"),
        "Host TEAM-EDGE\n  Port invalid\nHost build-* !build-exception\n",
    )
    .unwrap();
    let export = ConfigExport::new(dir.path().into());
    let mut hosts = HostStore::open(dir.path().join("hosts.json")).unwrap();
    let jump = hosts.upsert(None, host("Team Edge", "192.0.2.1")).unwrap();
    let mut downstream = host("Downstream", "192.0.2.2");
    downstream.jump_host = Some(jump.id);
    hosts.upsert(None, downstream).unwrap();
    for name in [
        "Build One",
        "Build Exception",
        "Duplicate",
        "DuPlicate",
        "中文",
    ] {
        hosts.upsert(None, host(name, "192.0.2.3")).unwrap();
    }
    let report = export
        .enable(
            export.preview().unwrap(),
            hosts.list(),
            &ConnectionSettings::default(),
        )
        .unwrap();
    assert_eq!(report.aliases.len(), 2);
    assert_eq!(report.aliases[0], "build-exception");
    assert!(report.aliases[1].starts_with("host-"));
    for (alias, reason) in [
        ("team-edge", ExportIssue::UserAlias),
        ("downstream", ExportIssue::JumpUnavailable),
        ("build-one", ExportIssue::UserAlias),
        ("duplicate", ExportIssue::DuplicateAlias),
    ] {
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.alias == alias && issue.reason == reason));
    }
}

#[test]
fn text_in_host_fields_cannot_create_an_openssh_directive() {
    let dir = tempfile::tempdir().unwrap();
    let mut hosts = HostStore::open(dir.path().join("hosts.json")).unwrap();
    let command =
        serde_json::from_value(json!({"mode":"proxyCommand","config":"sensitive command"}))
            .unwrap();
    let mut bad_proxy = host("Bad proxy", "192.0.2.1");
    bad_proxy.proxy = command;
    let mut bad_key = host("Bad key", "192.0.2.1");
    bad_key.auth = serde_json::from_value(
        json!({"type":"key","identityFile":"id_key\n  ProxyCommand sensitive command"}),
    )
    .unwrap();
    let app = hosts.upsert(None, host("Safe", "192.0.2.1")).unwrap();
    hosts
        .save_forward(
            &app.id,
            None,
            serde_json::from_value(json!({
                "type":"local","bindAddress":"127.0.0.1","bindPort":3000,
                "remoteHost":"host\nInclude unsafe.conf","remotePort":80,"autoStart":true
            }))
            .unwrap(),
        )
        .unwrap();
    hosts.upsert(None, bad_key).unwrap();
    hosts.upsert(None, bad_proxy).unwrap();
    hosts
        .upsert(None, host("Bad address", "host\nProxyCommand bad"))
        .unwrap();
    let fragment = generate(
        hosts.list(),
        &Default::default(),
        &ConnectionSettings::default(),
    );
    assert_eq!(fragment.report.aliases, ["safe"]);
    assert!(fragment
        .report
        .issues
        .iter()
        .any(|issue| issue.reason == ExportIssue::InvalidForward));
    for unsafe_text in [
        "ProxyCommand",
        "sensitive command",
        "Include",
        "LocalForward",
    ] {
        assert!(!fragment.text.contains(unsafe_text));
    }
}

#[test]
fn an_equivalent_global_include_counts_when_the_fragment_does_not_exist() {
    let dir = tempfile::tempdir().unwrap();
    let ssh = dir.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    let config = "Host user\n  Port 22\nHost *\n  Include ./ssh-astra.conf\n";
    fs::write(ssh.join("config"), config).unwrap();
    let export = ConfigExport::new(dir.path().into());
    let plan = export.preview().unwrap();
    assert!(!plan.adds_include());
    assert!(!ssh.join("ssh-astra.conf").exists());
    export
        .enable(plan, &[], &ConnectionSettings::default())
        .unwrap();
    assert!(ssh.join("ssh-astra.conf").exists());
    assert_eq!(fs::read_to_string(ssh.join("config")).unwrap(), config);
}
