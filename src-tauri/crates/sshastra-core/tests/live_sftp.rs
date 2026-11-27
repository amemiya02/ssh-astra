//! SFTP over a Host's live Connection (`ConnectionManager::open_sftp` /
//! `live_sftp`, `files::LiveHostFs`): what the File panel, transfers and
//! remote edits use. They never connect. Skipped when Docker is unavailable.

mod support;

use std::sync::Arc;

use sshastra_core::files::{FsError, LiveHostFs, OpenRemote, RemoteFs};
use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{
    BoxFuture, ConnectionManager, HostKeyPrompt, PasswordPrompt, Prompter, Secret,
};
use support::{Service, Sshd};

struct Trusting;

impl Prompter for Trusting {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, bool> {
        Box::pin(async { true })
    }

    fn password(&self, _: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        Box::pin(async { Some(Secret::new(support::PASSWORD)) })
    }
}

fn host(sshd: &Sshd) -> Host {
    Host {
        id: HostId::from("live-sftp".to_owned()),
        name: "live-sftp".into(),
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
        post_login_command: None,
        terminal_charset: None,
        terminal_backspace: None,
        default_directory: None,
        forwards: Vec::new(),
    }
}

fn manager(dir: &tempfile::TempDir) -> Arc<ConnectionManager> {
    Arc::new(ConnectionManager::new(KnownHosts::new(
        dir.path().join("known_hosts"),
    )))
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_live_connection_sftp_is_not_connected() {
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(&dir);
    let id = HostId::from("nowhere".to_owned());

    assert_eq!(
        manager.open_sftp(&id).await.err(),
        Some(FsError::NotConnected)
    );
    assert_eq!(
        manager.live_sftp(&id).await.err(),
        Some(FsError::NotConnected)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn live_sftp_shares_one_session_while_it_is_held() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(&dir);
    let host = host(&sshd);
    let _connection = manager.connect(&host, Arc::new(Trusting)).await.unwrap();

    let first = manager.live_sftp(&host.id).await.unwrap();
    let second = manager.live_sftp(&host.id).await.unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    // A browsing session is a session of its own.
    let own = manager.open_sftp(&host.id).await.unwrap();
    assert_eq!(own.home().await.unwrap(), "/home/tester");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_connection_gets_a_new_shared_session() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(&dir);
    let host = host(&sshd);
    let connection = manager.connect(&host, Arc::new(Trusting)).await.unwrap();
    let old = manager.live_sftp(&host.id).await.unwrap();
    drop(old);
    drop(connection);
    assert_eq!(
        manager.live_sftp(&host.id).await.err(),
        Some(FsError::NotConnected)
    );

    let _connection = manager.connect(&host, Arc::new(Trusting)).await.unwrap();
    let session = manager.live_sftp(&host.id).await.unwrap();
    assert_eq!(session.home().await.unwrap(), "/home/tester");
}

#[tokio::test(flavor = "multi_thread")]
async fn live_host_fs_reads_and_writes_over_the_live_connection() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let scratch = sshd.run_as_tester("d=$(mktemp -d) && printf %s \"$d\"");
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(&dir);
    let host = host(&sshd);
    let _connection = manager.connect(&host, Arc::new(Trusting)).await.unwrap();
    let open: OpenRemote = {
        let manager = Arc::clone(&manager);
        let id = host.id.clone();
        Arc::new(move || {
            let manager = Arc::clone(&manager);
            let id = id.clone();
            Box::pin(async move { Ok(manager.live_sftp(&id).await? as Arc<dyn RemoteFs>) })
        })
    };
    let fs = LiveHostFs::new(open);
    let path = format!("{}/note.txt", scratch.trim());

    // No other holder keeps the session open: the file handles must.
    fs.write_file(&path, b"hello").await.unwrap();
    assert_eq!(fs.read_file(&path).await.unwrap(), b"hello");
}

#[tokio::test(flavor = "multi_thread")]
async fn live_host_fs_is_not_connected_once_the_connection_is_gone() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(&dir);
    let host = host(&sshd);
    let connection = manager.connect(&host, Arc::new(Trusting)).await.unwrap();
    let open: OpenRemote = {
        let manager = Arc::clone(&manager);
        let id = host.id.clone();
        Arc::new(move || {
            let manager = Arc::clone(&manager);
            let id = id.clone();
            Box::pin(async move { Ok(manager.live_sftp(&id).await? as Arc<dyn RemoteFs>) })
        })
    };
    let fs = LiveHostFs::new(open);
    assert_eq!(fs.home().await.unwrap(), "/home/tester");
    drop(connection);

    assert_eq!(fs.home().await.err(), Some(FsError::NotConnected));
}
