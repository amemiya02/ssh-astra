//! SshConfigImporter, the saving half: parsed `~/.ssh/config` Hosts go into
//! the HostStore once, linked to their Jump hosts, and the report says what
//! happened. The last test connects to an imported Host through its imported
//! Jump host (Docker OpenSSH, see `support`).

mod support;

use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use sshastra_core::forward::ForwardKind;
use sshastra_core::hosts::{HostAuth, HostDraft, HostStore, ImportReport};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{
    BoxFuture, ConnectionManager, HostKeyDecision, HostKeyPrompt, PasswordPrompt, Prompter, Secret,
};
use sshastra_core::ssh_config::{
    parse, parse_user_config, ImportIssue, ImportProblem, ParseContext,
};
use sshastra_core::terminal::{Terminal, TerminalEvent, TerminalSize};
use support::Service;

fn store() -> (tempfile::TempDir, HostStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = HostStore::open(dir.path().join("hosts.json")).unwrap();
    (dir, store)
}

fn ctx() -> ParseContext {
    ParseContext {
        local_user: "me".into(),
    }
}

fn import(store: &mut HostStore, config: &str) -> ImportReport {
    let parsed = parse(config, &ctx(), &mut |p: &str| {
        Err(format!("{p}: unexpected"))
    });
    store.import_ssh_config(parsed).unwrap()
}

fn names(store: &HostStore) -> Vec<&str> {
    store.list().iter().map(|h| h.name.as_str()).collect()
}

fn find<'a>(store: &'a HostStore, name: &str) -> &'a sshastra_core::hosts::Host {
    store.list().iter().find(|h| h.name == name).unwrap()
}

const ALL: [&str; 5] = ["bastion", "app", "deep", "edge", "ops@gw.example.com:2200"];

const CONFIG: &str = "
Host bastion
    HostName bastion.example.com
    User jump
    IdentityFile ~/.ssh/id_ed25519
Host app
    HostName 10.0.0.7
    ProxyJump bastion
    LocalForward 8080 localhost:80
Host deep
    ProxyJump bastion,app
Host edge
    ProxyJump ops@gw.example.com:2200
Host bad
    Port nope
";

#[test]
fn ssh_config_import_lists_saved_proxy_commands_without_running_them() {
    use sshastra_core::proxy::HostProxy;

    let (dir, mut store) = store();
    let marker = dir.path().join("proxy-started");
    let command = format!(
        "printf '%s' '$HOME' > {} && nc  \"%h\" %p",
        sshastra_core::ssh::shell_quote(marker.to_str().unwrap())
    );
    let report = import(
        &mut store,
        &format!(
            "Host first second\n  ProxyCommand= {command}\nHost disabled\n  ProxyCommand none"
        ),
    );

    assert!(!marker.exists());
    assert_eq!(report.imported, ["first", "second", "disabled"]);
    assert!(report.issues.is_empty());
    assert_eq!(
        serde_json::to_value(&report).unwrap()["proxyCommands"],
        serde_json::json!([
            {"host": "first", "command": command},
            {"host": "second", "command": command},
        ])
    );
    let reopened = HostStore::open(dir.path().join("hosts.json")).unwrap();
    for name in ["first", "second"] {
        assert_eq!(
            find(&reopened, name).proxy,
            HostProxy::ProxyCommand(command.clone())
        );
    }
    assert_eq!(find(&reopened, "disabled").proxy, HostProxy::Inherit);

    let repeated = import(&mut store, &format!("Host first\n  ProxyCommand {command}"));
    assert_eq!(repeated.skipped, ["first"]);
    assert!(repeated.proxy_commands.is_empty());
    assert!(!marker.exists());
}

#[test]
fn imported_hosts_keep_their_server_alive_interval() {
    let (dir, mut store) = store();

    let report = import(
        &mut store,
        "
Host app
    ProxyJump ops@gw.example.com:2200
    ServerAliveInterval 0
    ServerAliveInterval 60
Host inherited
Host *.example.com
    ServerAliveInterval 1m15.5s
Host invalid
    ServerAliveInterval -1
",
    );
    assert_eq!(
        report.imported,
        ["app", "ops@gw.example.com:2200", "inherited"]
    );
    assert_eq!(
        report.issues,
        [ImportIssue {
            entry: "invalid".into(),
            dropped: true,
            problem: ImportProblem::InvalidValue {
                directive: "ServerAliveInterval".into(),
                value: "-1".into(),
            },
        }]
    );

    let path = dir.path().join("hosts.json");
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(saved["hosts"][0]["keepaliveSeconds"], 0);
    assert_eq!(saved["hosts"][1]["keepaliveSeconds"], 75);
    assert!(saved["hosts"][2].get("keepaliveSeconds").is_none());
}

#[test]
fn imported_hosts_are_saved_with_their_settings_jump_hosts_and_forwards() {
    let (_dir, mut store) = store();

    let report = import(&mut store, CONFIG);

    assert_eq!(names(&store), ALL);
    let bastion = find(&store, "bastion");
    assert_eq!(bastion.address, "bastion.example.com");
    assert_eq!(bastion.port, 22);
    assert_eq!(bastion.user, "jump");
    assert_eq!(
        bastion.auth,
        HostAuth::Key {
            identity_file: PathBuf::from("~/.ssh/id_ed25519")
        }
    );
    // ssh_config has no default directory: Hosts open in the home directory.
    assert_eq!(bastion.default_directory, None);
    let app = find(&store, "app");
    assert_eq!(app.auth, HostAuth::Auto);
    assert_eq!(app.jump_host.as_ref(), Some(&bastion.id));
    assert_eq!(app.forwards.len(), 1);
    assert_eq!(
        app.forwards[0].kind,
        ForwardKind::Local {
            bind_address: "127.0.0.1".into(),
            bind_port: 8080,
            remote_host: "localhost".into(),
            remote_port: 80,
        }
    );
    let gw = find(&store, "ops@gw.example.com:2200");
    assert_eq!(
        (gw.address.as_str(), gw.port, gw.user.as_str()),
        ("gw.example.com", 2200, "ops")
    );
    assert_eq!(find(&store, "edge").jump_host.as_ref(), Some(&gw.id));
    let deep = find(&store, "deep");
    assert_eq!(deep.jump_host.as_ref(), Some(&app.id));
    assert_eq!(
        store
            .jump_chain(&deep.id)
            .unwrap()
            .iter()
            .map(|h| h.name.as_str())
            .collect::<Vec<_>>(),
        ["bastion", "app", "deep"]
    );

    assert_eq!(report.imported, ALL);
    assert!(report.skipped.is_empty());
    assert_eq!(
        report.issues,
        [ImportIssue {
            entry: "bad".into(),
            dropped: true,
            problem: ImportProblem::InvalidValue {
                directive: "Port".into(),
                value: "nope".into(),
            },
        }]
    );
}

#[test]
fn import_keeps_identities_only_with_first_matching_value_and_persists_it() {
    let (dir, mut store) = store();
    let report = import(
        &mut store,
        "
Host build
    IdentityFile ~/.ssh/build
    IdentitiesOnly yes
Host auto
    IdentitiesOnly YES
Host off
    IdentitiesOnly no
Host *
    IdentitiesOnly yes
",
    );
    assert_eq!(report.imported, ["build", "auto", "off"]);
    assert!(report.issues.is_empty());
    let saved = HostStore::open(dir.path().join("hosts.json")).unwrap();
    let build = find(&saved, "build");
    assert_eq!(
        build.auth,
        HostAuth::Key {
            identity_file: "~/.ssh/build".into()
        }
    );
    assert!(build.identities_only);
    let auto = find(&saved, "auto");
    assert_eq!(auto.auth, HostAuth::Auto);
    assert!(auto.identities_only);
    assert!(!find(&saved, "off").identities_only);
}

#[test]
fn agent_forwarding_import_uses_the_first_matching_value_and_defaults_to_off() {
    let (dir, mut store) = store();
    let report = import(
        &mut store,
        "
Host build
    ForwardAgent YES
Host login
    ForwardAgent no
Host build login
    ForwardAgent yes
Host plain
    User dev
",
    );
    assert_eq!(report.imported, ["build", "login", "plain"]);
    assert!(report.issues.is_empty());

    let saved = HostStore::open(dir.path().join("hosts.json")).unwrap();
    for (name, expected) in [("build", true), ("login", false), ("plain", false)] {
        let host = serde_json::to_value(find(&saved, name)).unwrap();
        assert_eq!(host["forwardAgent"], expected, "{name}");
    }
}

#[test]
fn importing_again_adds_nothing_and_reports_every_host_as_skipped() {
    let (_dir, mut store) = store();
    import(&mut store, CONFIG);
    let before = store.list().to_vec();

    let report = import(&mut store, CONFIG);

    assert_eq!(store.list(), before.as_slice());
    assert!(report.imported.is_empty());
    assert_eq!(report.skipped, ALL);
}

#[test]
fn a_host_with_a_taken_name_is_skipped_and_its_namesake_used_as_jump_host() {
    let (_dir, mut store) = store();
    let mine = store
        .upsert(
            None,
            HostDraft {
                name: "bastion".into(),
                tags: Vec::new(),
                icon: None,
                color: None,
                address: "my-bastion".into(),
                port: 2200,
                user: "me".into(),
                auth: HostAuth::Password,
                jump_host: None,
                terminal_scheme: None,
                identities_only: false,
                forward_agent: false,
                proxy: Default::default(),
                keepalive_seconds: None,
                post_login_command: None,
                terminal_charset: None,
                terminal_backspace: None,
                default_directory: None,
            },
        )
        .unwrap();

    let report = import(&mut store, "Host bastion\nHost app\n  ProxyJump bastion\n");

    assert_eq!(report.imported, ["app"]);
    assert_eq!(report.skipped, ["bastion"]);
    assert_eq!(find(&store, "bastion").address, "my-bastion");
    assert_eq!(find(&store, "app").jump_host.as_ref(), Some(&mine.id));
}

#[test]
fn the_import_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hosts.json");
    import(&mut HostStore::open(&path).unwrap(), CONFIG);

    assert_eq!(names(&HostStore::open(&path).unwrap()), ALL);
}

#[test]
fn the_users_config_and_its_includes_are_read_from_the_home_directory() {
    let home = tempfile::tempdir().unwrap();
    let ssh = home.path().join(".ssh");
    fs::create_dir_all(ssh.join("conf.d")).unwrap();
    fs::write(
        ssh.join("config"),
        "Include conf.d/*.conf\nInclude ~/.ssh/nowhere\nHost main\n",
    )
    .unwrap();
    fs::write(ssh.join("conf.d/b.conf"), "Host b\n").unwrap();
    fs::write(ssh.join("conf.d/a.conf"), "Host a\n").unwrap();
    fs::write(ssh.join("conf.d/ignored.txt"), "Host ignored\n").unwrap();

    let parsed = parse_user_config(home.path(), &ctx()).unwrap();

    let names: Vec<_> = parsed.hosts.iter().map(|h| h.name.as_str()).collect();
    assert_eq!(names, ["a", "b", "main"]);
    assert!(parsed.issues.is_empty());
}

#[test]
fn no_config_file_imports_nothing() {
    let home = tempfile::tempdir().unwrap();
    let parsed = parse_user_config(home.path(), &ctx()).unwrap();
    assert!(parsed.hosts.is_empty() && parsed.issues.is_empty());
}

/// Trusts every host key and answers every password prompt.
struct Trusting {
    passwords: Mutex<VecDeque<String>>,
}

impl Prompter for Trusting {
    fn confirm_host_key(&self, _prompt: HostKeyPrompt) -> BoxFuture<'_, HostKeyDecision> {
        Box::pin(async { HostKeyDecision::SaveAndTrust })
    }

    fn password(&self, _prompt: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        let answer = self.passwords.lock().unwrap().pop_front().map(Secret::new);
        Box::pin(async move { answer })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_imported_host_behind_an_imported_jump_host_connects() {
    let Some(sshd) = support::sshd(Service::Jump) else {
        return;
    };
    let (_dir, mut store) = store();
    let config = format!(
        "
Host jump
    HostName {}
    Port {}
Host internal
    ProxyJump jump
Host *
    User {}
",
        sshd.host,
        sshd.port,
        support::USER
    );
    let report = import(&mut store, &config);
    assert_eq!(report.imported, ["jump", "internal"]);

    let chain = store.jump_chain(&find(&store, "internal").id).unwrap();
    let (target, jumps) = chain.split_last().unwrap();
    let home = tempfile::tempdir().unwrap();
    let manager = ConnectionManager::new(KnownHosts::new(home.path().join("known_hosts")))
        .with_home_dir(home.path());
    let prompter = Arc::new(Trusting {
        passwords: Mutex::new(VecDeque::from(vec![sshd.password.to_owned(); 2])),
    });
    let connection = manager
        .connect_through(jumps, target, prompter)
        .await
        .unwrap();

    let (tx, rx) = std::sync::mpsc::channel();
    let mut shell = connection
        .open_shell(TerminalSize { cols: 80, rows: 24 }, move |event| {
            if let TerminalEvent::Output(bytes) = event {
                let _ = tx.send(bytes);
            }
        })
        .await
        .unwrap();
    shell.write(b"echo \"on-$(hostname)-$((1+1))\"\n").unwrap();
    let mut seen = Vec::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !String::from_utf8_lossy(&seen).contains("on-internal-2") {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        seen.extend(rx.recv_timeout(left).expect("shell output"));
    }
    shell.close().unwrap();
}
