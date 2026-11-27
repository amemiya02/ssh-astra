//! SshConfigImporter, the parsing half: `~/.ssh/config` text in, the Hosts it
//! describes (plus what could not be understood) out. Table-driven, from
//! configs shaped like real ones.

use std::collections::HashMap;
use std::path::PathBuf;

use sshastra_core::forward::{ForwardDraft, ForwardKind};
use sshastra_core::ssh_config::{
    parse, ConfigHost, ImportIssue, ImportProblem, IncludedFile, ParseContext, ParsedConfig,
};

const LOCAL_USER: &str = "me";

fn host(name: &str) -> ConfigHost {
    ConfigHost {
        name: name.into(),
        address: name.into(),
        port: 22,
        user: LOCAL_USER.into(),
        identity_file: None,
        identities_only: false,
        jump_host: None,
        forwards: Vec::new(),
    }
}

trait With {
    fn address(self, a: &str) -> Self;
    fn port(self, p: u16) -> Self;
    fn user(self, u: &str) -> Self;
    fn key(self, k: &str) -> Self;
    fn jump(self, j: &str) -> Self;
    fn local(self, bind_address: &str, bind_port: u16, remote_host: &str, remote_port: u16)
        -> Self;
    fn remote(self, bind_address: &str, bind_port: u16, local_host: &str, local_port: u16) -> Self;
    fn dynamic(self, bind_address: &str, bind_port: u16) -> Self;
    fn forward(self, kind: ForwardKind) -> Self;
}

impl With for ConfigHost {
    fn address(mut self, a: &str) -> Self {
        self.address = a.into();
        self
    }
    fn port(mut self, p: u16) -> Self {
        self.port = p;
        self
    }
    fn user(mut self, u: &str) -> Self {
        self.user = u.into();
        self
    }
    fn key(mut self, k: &str) -> Self {
        self.identity_file = Some(PathBuf::from(k));
        self
    }
    fn jump(mut self, j: &str) -> Self {
        self.jump_host = Some(j.into());
        self
    }
    fn local(
        self,
        bind_address: &str,
        bind_port: u16,
        remote_host: &str,
        remote_port: u16,
    ) -> Self {
        self.forward(ForwardKind::Local {
            bind_address: bind_address.into(),
            bind_port,
            remote_host: remote_host.into(),
            remote_port,
        })
    }
    fn remote(self, bind_address: &str, bind_port: u16, local_host: &str, local_port: u16) -> Self {
        self.forward(ForwardKind::Remote {
            bind_address: bind_address.into(),
            bind_port,
            local_host: local_host.into(),
            local_port,
        })
    }
    fn dynamic(self, bind_address: &str, bind_port: u16) -> Self {
        self.forward(ForwardKind::Dynamic {
            bind_address: bind_address.into(),
            bind_port,
        })
    }
    /// Forwards in `~/.ssh/config` run on every connect, so they auto-start.
    fn forward(mut self, kind: ForwardKind) -> Self {
        self.forwards.push(ForwardDraft {
            label: String::new(),
            auto_start: true,
            kind,
        });
        self
    }
}

fn issue(entry: &str, dropped: bool, problem: ImportProblem) -> ImportIssue {
    ImportIssue {
        entry: entry.into(),
        dropped,
        problem,
    }
}

fn invalid(directive: &str, value: &str) -> ImportProblem {
    ImportProblem::InvalidValue {
        directive: directive.into(),
        value: value.into(),
    }
}

fn unsupported(directive: &str) -> ImportProblem {
    ImportProblem::Unsupported {
        directive: directive.into(),
    }
}

type Files = &'static [(&'static str, &'static [(&'static str, &'static str)])];

fn parse_with(text: &str, files: Files) -> ParsedConfig {
    let files: HashMap<&str, Vec<IncludedFile>> = files
        .iter()
        .map(|(pattern, found)| {
            let found = found
                .iter()
                .map(|(name, text)| IncludedFile {
                    name: (*name).into(),
                    text: (*text).into(),
                })
                .collect();
            (*pattern, found)
        })
        .collect();
    let ctx = ParseContext {
        local_user: LOCAL_USER.into(),
    };
    parse(text, &ctx, &mut |pattern: &str| {
        files
            .get(pattern)
            .cloned()
            .ok_or_else(|| format!("{pattern}: no such file"))
    })
}

struct Case {
    name: &'static str,
    config: &'static str,
    includes: Files,
    hosts: Vec<ConfigHost>,
    issues: Vec<ImportIssue>,
}

fn case(name: &'static str, config: &'static str) -> Case {
    Case {
        name,
        config,
        includes: &[],
        hosts: Vec::new(),
        issues: Vec::new(),
    }
}

impl Case {
    fn includes(mut self, includes: Files) -> Self {
        self.includes = includes;
        self
    }
    fn hosts(mut self, hosts: Vec<ConfigHost>) -> Self {
        self.hosts = hosts;
        self
    }
    fn issues(mut self, issues: Vec<ImportIssue>) -> Self {
        self.issues = issues;
        self
    }
}

fn cases() -> Vec<Case> {
    vec![
        case(
            "basic directives, any keyword case, `=` or spaces",
            "
# work
Host web
    HostName 203.0.113.10
    Port 2222
    User deploy
    IdentityFile ~/.ssh/id_ed25519

Host db
  hostname=db.internal
  USER = postgres
",
        )
        .hosts(vec![
            host("web")
                .address("203.0.113.10")
                .port(2222)
                .user("deploy")
                .key("~/.ssh/id_ed25519"),
            host("db").address("db.internal").user("postgres"),
        ]),
        case(
            "a Host line naming several aliases makes one Host each; patterns make none",
            "
Host alpha beta *.example.com !gamma
    User ops
",
        )
        .hosts(vec![host("alpha").user("ops"), host("beta").user("ops")]),
        case(
            "Host * at the end supplies defaults; the first value obtained wins",
            "
Host web
    User deploy

Host *
    User fallback
    Port 2200
    IdentityFile ~/.ssh/id_rsa
",
        )
        .hosts(vec![host("web")
            .user("deploy")
            .port(2200)
            .key("~/.ssh/id_rsa")]),
        case(
            "settings before any Host line, and wildcard blocks, apply to matching aliases",
            "
User global
Host *.prod web
    Port 2022
Host api.prod
    HostName 10.0.0.5
Host web
    HostName web.example.com
Host !web *
    IdentityFile ~/.ssh/other
",
        )
        .hosts(vec![
            host("web")
                .address("web.example.com")
                .user("global")
                .port(2022),
            host("api.prod")
                .address("10.0.0.5")
                .user("global")
                .port(2022)
                .key("~/.ssh/other"),
        ]),
        case(
            "HostName and IdentityFile tokens are expanded",
            "
Host box
    HostName %h.lan
    User admin
    IdentityFile %d/.ssh/%r@%h_%u
",
        )
        .hosts(vec![host("box")
            .address("box.lan")
            .user("admin")
            .key("~/.ssh/admin@box.lan_me")]),
        case(
            "quoted values and trailing comments",
            "
Host \"quoted\"
    IdentityFile \"~/My Keys/id_ed25519\" # laptop key
",
        )
        .hosts(vec![host("quoted").key("~/My Keys/id_ed25519")]),
        case(
            "ProxyJump names another alias; `none` means direct",
            "
Host bastion
    HostName bastion.example.com
    User jump
Host internal
    HostName 10.1.0.4
    ProxyJump bastion
Host direct
    ProxyJump none
",
        )
        .hosts(vec![
            host("bastion").address("bastion.example.com").user("jump"),
            host("internal").address("10.1.0.4").jump("bastion"),
            host("direct"),
        ]),
        case(
            "Host * ProxyJump with the bastion opting out",
            "
Host bastion
    HostName bastion.example.com
    ProxyJump none
Host app
Host *
    ProxyJump bastion
",
        )
        .hosts(vec![
            host("bastion").address("bastion.example.com"),
            host("app").jump("bastion"),
        ]),
        case(
            "a ProxyJump chain of literal hops becomes Jump hosts of their own",
            "
Host deep
    ProxyJump ops@gw.example.com:2222,inner.example.com
Host *.example.com
    User corp
",
        )
        .hosts(vec![
            host("deep").jump("inner.example.com"),
            host("ops@gw.example.com:2222")
                .address("gw.example.com")
                .user("ops")
                .port(2222),
            host("inner.example.com")
                .user("corp")
                .jump("ops@gw.example.com:2222"),
        ]),
        case(
            "a chain through aliases links them in order",
            "
Host a
    HostName a.example.com
Host b
    HostName b.internal
    ProxyJump a
Host c
    ProxyJump a,b
",
        )
        .hosts(vec![
            host("a").address("a.example.com"),
            host("b").address("b.internal").jump("a"),
            host("c").jump("b"),
        ]),
        case(
            "a chain whose alias hop is reached differently is refused",
            "
Host a
Host b
Host c
    ProxyJump a,b
",
        )
        .hosts(vec![host("a"), host("b")])
        .issues(vec![issue(
            "c",
            true,
            ImportProblem::JumpChainConflict { hop: "b".into() },
        )]),
        case(
            "Jump hosts that loop are not imported",
            "
Host x
    ProxyJump y
Host y
    ProxyJump x
Host ok
",
        )
        .hosts(vec![host("ok")])
        .issues(vec![
            issue("x", true, ImportProblem::JumpHostLoop),
            issue("y", true, ImportProblem::JumpHostLoop),
        ]),
        case(
            "a Host behind a Jump host that is not imported is not imported either",
            "
Host broken
    Port 0
Host behind
    ProxyJump broken
",
        )
        .issues(vec![
            issue("broken", true, invalid("Port", "0")),
            issue(
                "behind",
                true,
                ImportProblem::JumpHostUnavailable {
                    hop: "broken".into(),
                },
            ),
        ]),
        case(
            "LocalForward in every spelling becomes a local Port forward rule",
            "
Host tunnels
    LocalForward 8080 localhost:80
    LocalForward 0.0.0.0:5433 db.internal:5432
    LocalForward *:9000 [2001:db8::1]:9000
    LocalForward [::1]:6379 cache:6379
    LocalForward=7000 svc:70
",
        )
        .hosts(vec![host("tunnels")
            .local("127.0.0.1", 8080, "localhost", 80)
            .local("0.0.0.0", 5433, "db.internal", 5432)
            .local("0.0.0.0", 9000, "2001:db8::1", 9000)
            .local("::1", 6379, "cache", 6379)
            .local("127.0.0.1", 7000, "svc", 70)]),
        case(
            "LocalForward from Host * is added to every Host",
            "
Host one
Host two
    LocalForward 1000 x:1
Host *
    LocalForward 2000 y:2
",
        )
        .hosts(vec![
            host("one").local("127.0.0.1", 2000, "y", 2),
            host("two")
                .local("127.0.0.1", 1000, "x", 1)
                .local("127.0.0.1", 2000, "y", 2),
        ]),
        case(
            "a bad forward is dropped, the Host kept",
            "
Host svc
    LocalForward 8080
    LocalForward /tmp/sock remote:1
    LocalForward 99999 remote:1
",
        )
        .hosts(vec![host("svc")])
        .issues(vec![
            issue("svc", false, invalid("LocalForward", "8080")),
            issue("svc", false, invalid("LocalForward", "/tmp/sock remote:1")),
            issue("svc", false, invalid("LocalForward", "99999 remote:1")),
        ]),
        case(
            "RemoteForward becomes a remote Port forward rule",
            "
Host r
    RemoteForward 9000 localhost:3000
    RemoteForward 0.0.0.0:9001 127.0.0.1:3001
    RemoteForward *:9002 [::1]:3002
",
        )
        .hosts(vec![host("r")
            .remote("localhost", 9000, "localhost", 3000)
            .remote("0.0.0.0", 9001, "127.0.0.1", 3001)
            .remote("0.0.0.0", 9002, "::1", 3002)]),
        case(
            "DynamicForward becomes a dynamic (SOCKS) Port forward rule",
            "
Host d
    DynamicForward 1080
    DynamicForward *:1081
    DynamicForward [::1]:1082
",
        )
        .hosts(vec![host("d")
            .dynamic("127.0.0.1", 1080)
            .dynamic("0.0.0.0", 1081)
            .dynamic("::1", 1082)]),
        case(
            "a bad remote or dynamic forward is dropped, the Host kept",
            "
Host bad
    RemoteForward 9000
    RemoteForward 9000 /tmp/sock
    DynamicForward 0
    DynamicForward /tmp/sock
",
        )
        .hosts(vec![host("bad")])
        .issues(vec![
            issue("bad", false, invalid("RemoteForward", "9000")),
            issue("bad", false, invalid("RemoteForward", "9000 /tmp/sock")),
            issue("bad", false, invalid("DynamicForward", "0")),
            issue("bad", false, invalid("DynamicForward", "/tmp/sock")),
        ]),
        case(
            "a bad Port drops the Host",
            "
Host bad
    Port ssh
Host good
",
        )
        .hosts(vec![host("good")])
        .issues(vec![issue("bad", true, invalid("Port", "ssh"))]),
        case(
            "ProxyCommand Hosts cannot be reached and are not imported",
            "
Host legacy
    ProxyCommand ssh -W %h:%p gw
Host plain
Host *
    ProxyCommand none
",
        )
        .hosts(vec![host("plain")])
        .issues(vec![issue("legacy", true, unsupported("ProxyCommand"))]),
        case(
            "Match blocks are skipped and reported",
            "
Host a
Match host a exec \"true\"
    User matched
Host b
",
        )
        .hosts(vec![host("a"), host("b")])
        .issues(vec![issue(
            "Match host a exec \"true\"",
            false,
            unsupported("Match"),
        )]),
        case(
            "Include pulls in other files where it stands",
            "
Include config.d/*
Host main
    Include extra
    User after
",
        )
        .includes(&[
            (
                "config.d/*",
                &[
                    ("config.d/a", "Host fromA\n  User a\n"),
                    ("config.d/b", "Host fromB\n"),
                ],
            ),
            ("extra", &[("extra", "Port 2201\nHost other\n")]),
        ])
        .hosts(vec![
            host("fromA").user("a"),
            host("fromB"),
            host("main").port(2201).user("after"),
            host("other"),
        ]),
        case(
            "an unreadable Include is reported",
            "
Include missing
Host h
",
        )
        .hosts(vec![host("h")])
        .issues(vec![issue(
            "Include missing",
            false,
            ImportProblem::IncludeFailed {
                reason: "missing: no such file".into(),
            },
        )]),
        case("an Include loop stops", "Include self\nHost h\n")
            .includes(&[("self", &[("self", "Include self\n")])])
            .hosts(vec![host("h")])
            .issues(vec![issue(
                "Include self",
                false,
                ImportProblem::IncludeFailed {
                    reason: "includes are nested too deeply".into(),
                },
            )]),
        case(
            "a Host may appear in several blocks; it is imported once",
            "
Host web
    User a
Host web
    Port 2022
",
        )
        .hosts(vec![host("web").user("a").port(2022)]),
        case(
            "unknown and irrelevant directives are ignored",
            "
Host x
    ServerAliveInterval 30
    ForwardAgent yes
    SomethingNew 1
",
        )
        .hosts(vec![host("x")]),
        case("an empty file", "\n# nothing here\n"),
    ]
}

#[test]
fn ssh_config_parses_to_hosts() {
    for case in cases() {
        let parsed = parse_with(case.config, case.includes);
        assert_eq!(parsed.hosts, case.hosts, "hosts: {}", case.name);
        assert_eq!(parsed.issues, case.issues, "issues: {}", case.name);
    }
}
