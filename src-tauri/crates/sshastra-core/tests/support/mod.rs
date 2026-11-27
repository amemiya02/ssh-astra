//! Shared harness for integration tests against real OpenSSH servers in
//! Docker (`tests/sshd/docker-compose.yml`).
//!
//! ```ignore
//! mod support;
//! let Some(sshd) = support::sshd(support::Service::Ssh) else { return };
//! ```
//!
//! `SSHASTRA_DOCKER_TESTS` controls what happens:
//! - unset / `auto`: start the containers if Docker works, else skip (the test
//!   returns early and prints why).
//! - `require`: fail instead of skipping (CI on Linux).
//! - `skip`: never touch Docker.
//!
//! Containers are started once per test binary and left running so reruns are
//! fast. Each checkout gets its own Compose project and image tag
//! ([`project`]), so parallel worktrees never clobber each other's services.
//! Stop them with `docker compose -p <project> down` (`docker compose ls`
//! lists the `sshastra-it-*` projects).
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use sshastra_core::known_hosts::HostKey;

pub const USER: &str = "tester";
pub const PASSWORD: &str = "testpass";
/// A user whose login shell is zsh (same password), for ShellIntegration tests.
pub const ZSH_USER: &str = "zester";

/// The TCP echo server (`echo` in `tests/sshd/docker-compose.yml`) as the
/// sshd servers on the public network see it: every byte sent comes back.
pub const ECHO: (&str, u16) = ("echo", 7777);

/// A service in `tests/sshd/docker-compose.yml` reachable from the tests.
#[derive(Debug, Clone, Copy)]
pub enum Service {
    /// The plain target.
    Ssh,
    /// A Jump host that can also reach `internal:22`.
    Jump,
    /// Accepts public keys only.
    KeyOnly,
    /// Accepts only certificates issued by the integration test CA.
    Certificate,
    /// Accepts only the `id_ed25519` fixture and limits authentication to two tries.
    LimitedAuth,
    /// Keyboard-interactive (PAM asks for the password), alone or after a
    /// public key; no password method.
    KbdInt,
    /// A target nothing else connects to, so a test can count the TCP
    /// connections it sees. Tests using it must not run concurrently.
    Counted,
    /// A target only `tests/reconnect.rs` uses: it kills and freezes the
    /// server to drop Connections. Tests using it must not run concurrently.
    Flaky,
    /// Accepts TCP but never speaks SSH (no banner).
    Silent,
}

impl Service {
    fn name(self) -> &'static str {
        match self {
            Service::Ssh => "ssh",
            Service::Jump => "jump",
            Service::KeyOnly => "keyonly",
            Service::Certificate => "certificate",
            Service::LimitedAuth => "limitedauth",
            Service::KbdInt => "kbdint",
            Service::Counted => "counted",
            Service::Flaky => "flaky",
            Service::Silent => "silent",
        }
    }
}

/// How to reach one running OpenSSH server.
#[derive(Debug, Clone)]
pub struct Sshd {
    pub service: Service,
    pub host: String,
    pub port: u16,
    pub user: &'static str,
    pub password: &'static str,
    /// The key the server presents (fixture in `tests/sshd/`).
    pub host_key: HostKey,
}

fn core_dir() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    if env!("CARGO_PKG_NAME") == "sshastra-core" {
        manifest.to_path_buf()
    } else {
        manifest.join("crates/sshastra-core")
    }
}

pub fn sshd_dir() -> PathBuf {
    core_dir().join("tests/sshd")
}

/// The server for `service`, starting the containers if needed. `None` means
/// Docker is unavailable and the calling test should return early.
pub fn sshd(service: Service) -> Option<Sshd> {
    let mode = std::env::var("SSHASTRA_DOCKER_TESTS").unwrap_or_default();
    if mode == "skip" {
        return None;
    }
    static STARTED: OnceLock<Result<(), String>> = OnceLock::new();
    if let Err(why) = STARTED.get_or_init(compose_up) {
        if mode == "require" {
            panic!("SSHASTRA_DOCKER_TESTS=require but the test sshd is unavailable: {why}");
        }
        eprintln!("skipping Docker integration test: {why}");
        return None;
    }

    let published = compose(&["port", service.name(), "22"])
        .unwrap_or_else(|e| panic!("no published port for {}: {e}", service.name()));
    let (host, port) = published
        .trim()
        .rsplit_once(':')
        .unwrap_or_else(|| panic!("unexpected `docker compose port` output: {published}"));
    let host_key = std::fs::read_to_string(sshd_dir().join("ssh_host_ed25519_key.pub")).unwrap();

    Some(Sshd {
        service,
        host: host.to_owned(),
        port: port.parse().unwrap(),
        user: USER,
        password: PASSWORD,
        host_key: HostKey::from_openssh(&host_key).unwrap(),
    })
}

/// A test-only key or certificate fixture in `tests/sshd/keys/`.
pub fn key(name: &str) -> PathBuf {
    sshd_dir().join("keys").join(name)
}

/// The passphrase of `key("id_ed25519_passphrase")`.
pub const KEY_PASSPHRASE: &str = "testphrase";

/// The Compose project (and image tag prefix) for this checkout:
/// `$SSHASTRA_IT_PROJECT` if set, else `sshastra-it-<hash of the checkout
/// path>`.
pub fn project() -> String {
    if let Ok(name) = std::env::var("SSHASTRA_IT_PROJECT") {
        if !name.trim().is_empty() {
            return name.trim().to_owned();
        }
    }
    // FNV-1a: stable across toolchains, unlike `DefaultHasher`.
    let hash = core_dir()
        .to_string_lossy()
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
        });
    format!("sshastra-it-{:08x}", hash as u32)
}

impl Sshd {
    /// How many established TCP connections the server has on port 22, as
    /// its kernel sees them (`/proc/net/tcp{,6}` inside the container).
    pub fn established_connections(&self) -> usize {
        let tables = compose(&[
            "exec",
            "-T",
            self.service.name(),
            "cat",
            "/proc/net/tcp",
            "/proc/net/tcp6",
        ])
        .unwrap_or_else(|e| panic!("cannot read {}'s sockets: {e}", self.service.name()));
        tables
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                let local = fields.nth(1)?;
                let state = fields.nth(1)?;
                Some((local, state))
            })
            // Local port 22 (hex 0016), state 01 = ESTABLISHED.
            .filter(|(local, state)| local.ends_with(":0016") && *state == "01")
            .count()
    }
}

impl Sshd {
    /// Runs a `bash` script inside the server's container as `tester` (to
    /// set up files a test needs) and returns its stdout.
    pub fn run_as_tester(&self, script: &str) -> String {
        compose(&[
            "exec",
            "-T",
            "-u",
            "tester",
            self.service.name(),
            "bash",
            "-c",
            script,
        ])
        .unwrap_or_else(|e| panic!("script failed on {}: {e}", self.service.name()))
    }
}

impl Sshd {
    /// Kills the server's per-connection processes, so every Connection to
    /// it drops at once (as when the server restarts or the network resets).
    pub fn drop_connections(&self) {
        let script = r#"for p in /proc/[0-9]*; do
            if tr '\0' ' ' < "$p/cmdline" 2>/dev/null | grep -q '^sshd: tester'; then
                kill -9 "${p#/proc/}" 2>/dev/null
            fi
        done; true"#;
        compose(&["exec", "-T", self.service.name(), "bash", "-c", script])
            .unwrap_or_else(|e| panic!("cannot drop {}'s connections: {e}", self.service.name()));
    }

    /// Freezes the server: its connections stay open but nothing answers,
    /// as when the network silently goes away. Undo with [`Self::unpause`].
    pub fn pause(&self) {
        compose(&["pause", self.service.name()])
            .unwrap_or_else(|e| panic!("cannot pause {}: {e}", self.service.name()));
    }

    pub fn unpause(&self) {
        compose(&["unpause", self.service.name()])
            .unwrap_or_else(|e| panic!("cannot unpause {}: {e}", self.service.name()));
    }
}

fn compose_up() -> Result<(), String> {
    compose(&["up", "--detach", "--build", "--wait", "--quiet-pull"]).map(drop)
}

fn compose(args: &[&str]) -> Result<String, String> {
    let file = sshd_dir().join("docker-compose.yml");
    let project = project();
    // The compose file names its image `${SSHASTRA_IT_PROJECT}-sshd`.
    let output = Command::new("docker")
        .env("SSHASTRA_IT_PROJECT", &project)
        .arg("compose")
        .arg("--project-name")
        .arg(&project)
        .arg("--file")
        .arg(&file)
        .args(args)
        .output()
        .map_err(|e| format!("cannot run docker: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(format!(
            "`docker compose {}` failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}
