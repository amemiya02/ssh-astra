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

/// A service in `tests/sshd/docker-compose.yml` reachable from the tests.
#[derive(Debug, Clone, Copy)]
pub enum Service {
    /// The plain target.
    Ssh,
    /// A Jump host that can also reach `internal:22`.
    Jump,
    /// Accepts public keys only.
    KeyOnly,
    /// Keyboard-interactive (PAM asks for the password), alone or after a
    /// public key; no password method.
    KbdInt,
}

impl Service {
    fn name(self) -> &'static str {
        match self {
            Service::Ssh => "ssh",
            Service::Jump => "jump",
            Service::KeyOnly => "keyonly",
            Service::KbdInt => "kbdint",
        }
    }
}

/// How to reach one running OpenSSH server.
#[derive(Debug, Clone)]
pub struct Sshd {
    pub host: String,
    pub port: u16,
    pub user: &'static str,
    pub password: &'static str,
    /// The key the server presents (fixture in `tests/sshd/`).
    pub host_key: HostKey,
}

pub fn sshd_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("sshd")
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
        host: host.to_owned(),
        port: port.parse().unwrap(),
        user: USER,
        password: PASSWORD,
        host_key: HostKey::from_openssh(&host_key).unwrap(),
    })
}

/// A private key fixture in `tests/sshd/keys/` (e.g. `id_ed25519`). Its
/// public key is authorized for [`USER`] unless named `*_unauthorized`.
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
    let hash = env!("CARGO_MANIFEST_DIR")
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
        });
    format!("sshastra-it-{:08x}", hash as u32)
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
