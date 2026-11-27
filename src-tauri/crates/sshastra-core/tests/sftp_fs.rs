//! SftpFs (the File panel's view of a Host) against a real OpenSSH server in
//! Docker. The image has a fixed tree under `/srv/files` (see
//! `tests/sshd/Dockerfile`). Skipped when Docker is unavailable.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use sshastra_core::files::{
    self, FileKind, FsError, FsRegistry, NameMatch, NameSearchMode, RemoteFs, SftpFs,
};
use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{
    BoxFuture, ConnectionManager, HostKeyDecision, HostKeyPrompt, PasswordPrompt, Prompter, Secret,
};
use support::{Service, Sshd};

struct Trusting(&'static str);

impl Prompter for Trusting {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, HostKeyDecision> {
        Box::pin(async { HostKeyDecision::SaveAndTrust })
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
        identities_only: false,
        forward_agent: false,
        proxy: Default::default(),
        keepalive_seconds: None,
        post_login_command: None,
        terminal_charset: None,
        terminal_backspace: None,
        default_directory: None,
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
async fn searching_names_finds_substrings_and_wildcards_without_following_links() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, _dir) = sftp(&sshd).await;
    let (_cancel, cancelled) = tokio::sync::oneshot::channel();
    let result = fs
        .search_names("/srv/files", "ell", NameSearchMode::Substring, cancelled)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        result.matches,
        [NameMatch {
            parent: "/srv/files".into(),
            name: "hello.txt".into()
        }]
    );

    let (_cancel, cancelled) = tokio::sync::oneshot::channel();
    let result = fs
        .search_names(
            "/srv/files/docs/../docs",
            ".*ote?",
            NameSearchMode::Wildcard,
            cancelled,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        result.matches,
        [NameMatch {
            parent: "/srv/files/docs/nested".into(),
            name: ".notes".into()
        }]
    );
    assert!(!result.limit_reached);
    assert!(
        !result.skipped_directories,
        "the link to locked/ was not followed"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_search_stops_at_its_entry_limit_even_inside_a_single_folder() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, _dir) = sftp(&sshd).await;
    let (_cancel, cancelled) = tokio::sync::oneshot::channel();
    let result = fs
        .search_names("/srv/files/many", "f*", NameSearchMode::Wildcard, cancelled)
        .await
        .unwrap()
        .unwrap();
    assert!(result.limit_reached);
    assert_eq!(result.visited, 1_000);
    assert_eq!(result.matches.len(), 1_000);
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_searches_leaves_the_file_panel_session_usable() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, _dir) = sftp(&sshd).await;
    let registry = FsRegistry::default();
    let id = registry.insert(Arc::new(fs));

    // Cancel while opening each scan channel. A leaked channel would reach
    // OpenSSH's ten concurrent session limit.
    for _ in 0..12 {
        let (request, fs, cancelled) = registry.start_scan(id).unwrap();
        let mut scan =
            fs.search_names("/srv/files/many", "f*", NameSearchMode::Wildcard, cancelled);
        tokio::select! {
            biased;
            result = &mut scan => panic!("search finished before cancellation: {result:?}"),
            _ = std::future::ready(()) => {}
        }
        registry.cancel_scan(id, request);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), scan)
                .await
                .unwrap()
                .unwrap(),
            None
        );
    }
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    drop(cancel);
    assert_eq!(
        registry
            .get(id)
            .unwrap()
            .search_names("/missing", "f*", NameSearchMode::Wildcard, cancelled)
            .await
            .unwrap(),
        None
    );
    let (_cancel, cancelled) = tokio::sync::oneshot::channel();
    let fs = registry.get(id).unwrap();
    assert_eq!(
        fs.search_names(
            "/srv/files/docs",
            "readme",
            NameSearchMode::Substring,
            cancelled
        )
        .await
        .unwrap()
        .unwrap()
        .matches
        .len(),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn folder_size_totals_nested_files_and_ignores_symlinks() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, _dir) = sftp(&sshd).await;
    let (_cancel, cancelled) = tokio::sync::oneshot::channel();

    assert_eq!(
        fs.folder_size("/srv/files/docs", cancelled).await.unwrap(),
        Some(15)
    );

    let (_cancel, cancelled) = tokio::sync::oneshot::channel();
    assert_eq!(
        fs.folder_size("/srv/files/docs-link/", cancelled).await,
        Err(FsError::NotADirectory("/srv/files/docs-link".into()))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_folder_sizes_leaves_the_file_panel_session_usable() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, _dir) = sftp(&sshd).await;
    let registry = FsRegistry::default();
    let id = registry.insert(Arc::new(fs));

    // Repeatedly cancel after the scan has started opening its SFTP channel.
    // OpenSSH allows ten concurrent session channels on this Connection.
    for _ in 0..12 {
        let (request, fs, cancelled) = registry.start_scan(id).unwrap();
        let mut scan = fs.folder_size("/srv/files/many", cancelled);
        tokio::select! {
            biased;
            finished = &mut scan => panic!("scan finished before cancellation: {finished:?}"),
            _ = std::future::ready(()) => {}
        }
        registry.cancel_scan(id, request);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), scan)
                .await
                .expect("scan should stop promptly")
                .unwrap(),
            None
        );
    }

    let fs = registry.get(id).unwrap();
    assert_eq!(
        fs.stat("/srv/files/docs").await.unwrap().kind,
        FileKind::Dir
    );
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
    let mut names: Vec<_> = via_link
        .entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    names.sort_unstable();
    assert_eq!(names, ["file-link", "folder-link", "nested", "readme.txt"]);
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
