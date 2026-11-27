//! The SSH handshake and authentication have a time limit, which only
//! counts time spent waiting on the network: time the user spends answering
//! a prompt does not. Uses the Docker `silent` service (accepts TCP, never
//! speaks SSH) and the plain `ssh` one.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{
    BoxFuture, ConnectError, ConnectionManager, HostKeyPrompt, PasswordPrompt, Prompter, Secret,
};
use support::{Service, Sshd};

/// Trusts and answers, but only after thinking for `delay`.
struct Slow {
    delay: Duration,
}

impl Prompter for Slow {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            tokio::time::sleep(self.delay).await;
            true
        })
    }

    fn password(&self, _: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        Box::pin(async move {
            tokio::time::sleep(self.delay).await;
            Some(Secret::new(support::PASSWORD))
        })
    }
}

fn host(sshd: &Sshd) -> Host {
    Host {
        id: HostId::from(format!("timeout-{:?}", sshd.service)),
        name: "timeout".into(),
        address: sshd.host.clone(),
        port: sshd.port,
        user: sshd.user.into(),
        auth: HostAuth::Password,
        jump_host: None,
        group_id: None,
        terminal_scheme: None,
        identities_only: false,
        forward_agent: false,
        keepalive_seconds: None,
        default_directory: None,
        forwards: Vec::new(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_that_never_speaks_ssh_times_out_with_a_readable_error() {
    let Some(sshd) = support::sshd(Service::Silent) else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let manager = ConnectionManager::new(KnownHosts::new(dir.path().join("known_hosts")))
        .with_handshake_timeout(Duration::from_secs(2));
    let started = Instant::now();

    let err = manager
        .connect(
            &host(&sshd),
            Arc::new(Slow {
                delay: Duration::ZERO,
            }),
        )
        .await
        .unwrap_err();

    assert!(matches!(err, ConnectError::TimedOut), "{err:?}");
    assert_eq!(err.to_string(), "the host did not answer in time");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn time_spent_answering_prompts_does_not_count_against_the_handshake() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let manager = ConnectionManager::new(KnownHosts::new(dir.path().join("known_hosts")))
        .with_handshake_timeout(Duration::from_secs(2));

    // Two prompts (host key, password) of 3 s each: far over the limit.
    let connection = manager
        .connect(
            &host(&sshd),
            Arc::new(Slow {
                delay: Duration::from_secs(3),
            }),
        )
        .await;

    assert!(connection.is_ok(), "{:?}", connection.err());
}
