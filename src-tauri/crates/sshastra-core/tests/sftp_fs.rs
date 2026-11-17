//! SftpFs (the File panel's view of a Host) against a real OpenSSH server in
//! Docker. The image has a fixed tree under `/srv/files` (see
//! `tests/sshd/Dockerfile`). Skipped when Docker is unavailable.

mod support;

use std::sync::Arc;
use std::time::Instant;

use sshastra_core::files::{self, FileKind, FsError, RemoteFs, SftpFs};
use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{
    BoxFuture, ConnectionManager, HostKeyPrompt, PasswordPrompt, Prompter, Secret,
};
use support::{Service, Sshd};

struct Trusting(&'static str);

impl Prompter for Trusting {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, bool> {
        Box::pin(async { true })
    }

    fn password(&self, _: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        Box::pin(async move { Some(Secret::new(self.0)) })
    }
}

/// An SftpFs on the `ssh` server, with the temp dir holding its known_hosts.
async fn sftp(sshd: &Sshd) -> (SftpFs, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let manager = ConnectionManager::new(KnownHosts::new(dir.path().join("known_hosts")));
    let host = Host {
        id: HostId::from("sftp".to_owned()),
        name: "sftp".into(),
        address: sshd.host.clone(),
        port: sshd.port,
        user: sshd.user.into(),
        auth: HostAuth::Password,
        jump_host: None,
        group_id: None,
        terminal_scheme: None,
        forwards: Vec::new(),
    };
    let connection = manager
        .connect(&host, Arc::new(Trusting(sshd.password)))
        .await
        .unwrap();
    (connection.open_sftp().await.unwrap(), dir)
}

#[tokio::test(flavor = "multi_thread")]
async fn home_is_the_users_home_directory() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, _dir) = sftp(&sshd).await;

    assert_eq!(fs.home().await.unwrap(), "/home/tester");
}

#[tokio::test(flavor = "multi_thread")]
async fn listing_a_directory_gives_each_entry_with_its_metadata() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, _dir) = sftp(&sshd).await;

    let mut entries = fs.list_dir("/srv/files").await.unwrap();
    entries.sort_by(|a, b| a.name.cmp(&b.name));

    let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(
        names,
        [
            ".hidden",
            "dangling",
            "docs",
            "docs-link",
            "hello.txt",
            "locked",
            "many"
        ]
    );
    let entry = |name: &str| entries.iter().find(|e| e.name == name).unwrap();

    let hello = entry("hello.txt");
    assert_eq!(hello.kind, FileKind::File);
    assert_eq!(hello.size, 6);
    assert_eq!(hello.permissions, Some(0o640));
    // 2024-01-02T03:04:05Z
    assert_eq!(hello.modified, Some(1_704_164_645));
    assert_eq!(hello.link_target, None);

    assert_eq!(entry("docs").kind, FileKind::Dir);
    assert_eq!(entry("locked").permissions, Some(0o700));

    let link = entry("docs-link");
    assert_eq!(link.kind, FileKind::Symlink);
    assert_eq!(link.link_target, Some(FileKind::Dir));
    let dangling = entry("dangling");
    assert_eq!(dangling.kind, FileKind::Symlink);
    assert_eq!(dangling.link_target, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn stat_follows_symlinks() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, _dir) = sftp(&sshd).await;

    let stat = fs.stat("/srv/files/hello.txt").await.unwrap();
    assert_eq!((stat.kind, stat.size), (FileKind::File, 6));
    assert_eq!(
        fs.stat("/srv/files/docs-link").await.unwrap().kind,
        FileKind::Dir
    );
    assert!(matches!(
        fs.stat("/srv/files/nope").await,
        Err(FsError::NotFound(path)) if path == "/srv/files/nope"
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn browse_resolves_the_path_before_listing() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, _dir) = sftp(&sshd).await;

    assert_eq!(files::browse(&fs, "").await.unwrap().path, "/home/tester");
    assert_eq!(files::browse(&fs, "~").await.unwrap().path, "/home/tester");
    let many = files::browse(&fs, "/srv/files/docs/../many/")
        .await
        .unwrap();
    assert_eq!(many.path, "/srv/files/many");
    let via_link = files::browse(&fs, "/srv/files/docs-link").await.unwrap();
    assert_eq!(via_link.path, "/srv/files/docs");
    assert!(via_link.entries.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn browse_reports_why_a_directory_cannot_be_shown() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, _dir) = sftp(&sshd).await;

    assert!(matches!(
        files::browse(&fs, "/srv/files/nope").await,
        Err(FsError::NotFound(_))
    ));
    assert!(matches!(
        files::browse(&fs, "/srv/files/locked").await,
        Err(FsError::PermissionDenied(_))
    ));
    assert!(matches!(
        files::browse(&fs, "/srv/files/hello.txt").await,
        Err(FsError::NotADirectory(path)) if path == "/srv/files/hello.txt"
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_directory_of_ten_thousand_entries_lists_in_full() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, _dir) = sftp(&sshd).await;

    let started = Instant::now();
    let listing = files::browse(&fs, "/srv/files/many").await.unwrap();
    eprintln!("listed 10,000 entries in {:?}", started.elapsed());

    assert_eq!(listing.entries.len(), 10_000);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_whole_file_is_written_and_read_back() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, _dir) = sftp(&sshd).await;
    let path = format!("/home/tester/write-{}.txt", uuid::Uuid::new_v4());

    fs.write_file(&path, b"first, longer contents\n")
        .await
        .unwrap();
    fs.write_file(&path, b"second\n").await.unwrap();

    assert_eq!(fs.read_file(&path).await.unwrap(), b"second\n");
    assert_eq!(fs.read_file("/srv/files/.hidden").await.unwrap(), b"x");
    assert!(matches!(
        fs.read_file("/srv/files/hello.txt").await,
        Err(FsError::PermissionDenied(_))
    ));
    assert!(matches!(
        fs.read_file("/srv/files/nope").await,
        Err(FsError::NotFound(_))
    ));
    assert!(matches!(
        fs.write_file("/srv/files/hello.txt", b"x").await,
        Err(FsError::PermissionDenied(_))
    ));
}
