//! File operations (create, rename, delete, chmod) through SftpFs against
//! a real OpenSSH server in Docker. Each test works in its own scratch
//! directory under tester's home; the shared `/srv/files` tree is only used
//! for operations that must fail (it is root-owned). Skipped when Docker is
//! unavailable.

mod support;

use std::sync::Arc;

use sshastra_core::files::{
    self, FileKind, FsError, PermissionChange, PermissionScope, RemoteFs, SftpFs,
};
use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{
    BoxFuture, Connection, ConnectionManager, HostKeyDecision, HostKeyPrompt, PasswordPrompt,
    Prompter, Secret,
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

async fn connect(sshd: &Sshd) -> (Arc<Connection>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let manager = ConnectionManager::new(KnownHosts::new(dir.path().join("known_hosts")));
    let host = Host {
        id: HostId::from("sftp-ops".to_owned()),
        name: "sftp-ops".into(),
        tags: Vec::new(),
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
    (connection, dir)
}

/// An SftpFs on the `ssh` server plus a fresh, empty scratch directory for
/// this test (absolute path), and the temp dir holding the known_hosts.
async fn scratch(sshd: &Sshd) -> (SftpFs, String, tempfile::TempDir) {
    let (connection, dir) = connect(sshd).await;
    let fs = connection.open_sftp().await.unwrap();
    let root = format!("/home/tester/ops-{}", uuid::Uuid::new_v4());
    fs.create_dir(&root).await.unwrap();
    (fs, root, dir)
}

fn names(entries: &[files::FileEntry]) -> Vec<String> {
    let mut names: Vec<_> = entries.iter().map(|e| e.name.clone()).collect();
    names.sort();
    names
}

#[tokio::test(flavor = "multi_thread")]
async fn creating_an_empty_file_refuses_to_replace_an_existing_path() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, root, _dir) = scratch(&sshd).await;
    let path = files::join(&root, "new file");

    fs.create_empty_file(&path).await.unwrap();
    let entries = fs.list_dir(&root).await.unwrap();
    assert_eq!(names(&entries), ["new file"]);
    assert_eq!(entries[0].kind, FileKind::File);
    assert_eq!(entries[0].size, 0);

    fs.write_file(&path, b"keep me").await.unwrap();
    assert_eq!(
        fs.create_empty_file(&path).await,
        Err(FsError::AlreadyExists(path.clone()))
    );
    assert_eq!(fs.read_file(&path).await.unwrap(), b"keep me");

    let link = files::join(&root, "dangling");
    sshd.run_as_tester(&format!("ln -s absent '{link}'"));
    assert_eq!(
        fs.create_empty_file(&link).await,
        Err(FsError::AlreadyExists(link.clone()))
    );
    assert_eq!(fs.lstat(&link).await.unwrap().kind, FileKind::Symlink);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_folder_appears_in_its_parent() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, root, _dir) = scratch(&sshd).await;

    fs.create_dir(&files::join(&root, "new folder"))
        .await
        .unwrap();

    let entries = fs.list_dir(&root).await.unwrap();
    assert_eq!(names(&entries), ["new folder"]);
    assert_eq!(entries[0].kind, FileKind::Dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_folder_fails_readably_when_the_name_is_taken_or_not_allowed() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, root, _dir) = scratch(&sshd).await;
    let taken = files::join(&root, "taken");
    fs.create_dir(&taken).await.unwrap();

    assert_eq!(
        fs.create_dir(&taken).await,
        Err(FsError::AlreadyExists(taken))
    );
    assert_eq!(
        fs.create_dir("/srv/files/new").await,
        Err(FsError::PermissionDenied("/srv/files/new".into()))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn renaming_moves_an_entry_to_its_new_name_but_never_over_another() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, root, _dir) = scratch(&sshd).await;
    let old = files::join(&root, "old");
    let new = files::join(&root, "new");
    let other = files::join(&root, "other");
    fs.create_dir(&old).await.unwrap();
    fs.create_dir(&other).await.unwrap();

    fs.rename(&old, &new).await.unwrap();
    assert_eq!(names(&fs.list_dir(&root).await.unwrap()), ["new", "other"]);

    assert_eq!(
        fs.rename(&new, &other).await,
        Err(FsError::AlreadyExists(other.clone()))
    );
    assert_eq!(
        fs.rename("/srv/files/hello.txt", "/srv/files/bye.txt")
            .await,
        Err(FsError::PermissionDenied("/srv/files/hello.txt".into()))
    );
    assert_eq!(names(&fs.list_dir(&root).await.unwrap()), ["new", "other"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_folder_removes_everything_in_it_but_not_what_its_links_point_to() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, root, _dir) = scratch(&sshd).await;
    // tree/{a.txt, sub/{b.txt, deeper/}, outside-link -> keep/}, keep/kept.txt
    sshd.run_as_tester(&format!(
        "cd '{root}' && mkdir -p tree/sub/deeper keep && echo a > tree/a.txt \
         && echo b > tree/sub/b.txt && echo k > keep/kept.txt \
         && ln -s ../keep tree/outside-link && echo x > lone.txt"
    ));
    let tree = files::join(&root, "tree");

    // The tree itself plus a.txt, sub, b.txt, deeper and the link.
    assert_eq!(files::count_tree(&fs, &tree).await.unwrap(), 6);
    assert_eq!(
        files::count_tree(&fs, &files::join(&root, "lone.txt"))
            .await
            .unwrap(),
        1
    );

    files::remove_tree(&fs, &tree).await.unwrap();
    files::remove_tree(&fs, &files::join(&root, "lone.txt"))
        .await
        .unwrap();

    assert_eq!(names(&fs.list_dir(&root).await.unwrap()), ["keep"]);
    assert_eq!(
        names(&fs.list_dir(&files::join(&root, "keep")).await.unwrap()),
        ["kept.txt"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_link_to_a_folder_removes_only_the_link() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, root, _dir) = scratch(&sshd).await;
    sshd.run_as_tester(&format!(
        "cd '{root}' && mkdir keep && echo k > keep/kept.txt && ln -s keep link"
    ));
    let link = files::join(&root, "link");

    assert_eq!(files::count_tree(&fs, &link).await.unwrap(), 1);
    files::remove_tree(&fs, &link).await.unwrap();

    assert_eq!(names(&fs.list_dir(&root).await.unwrap()), ["keep"]);
    assert_eq!(
        names(&fs.list_dir(&files::join(&root, "keep")).await.unwrap()),
        ["kept.txt"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_what_the_user_may_not_delete_says_so() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, _root, _dir) = scratch(&sshd).await;

    assert_eq!(
        files::remove_tree(&fs, "/srv/files/hello.txt").await,
        Err(FsError::PermissionDenied("/srv/files/hello.txt".into()))
    );
    assert!(matches!(
        files::remove_tree(&fs, "/srv/files/docs").await,
        Err(FsError::PermissionDenied(path)) if path.starts_with("/srv/files/docs/")
    ));
    assert_eq!(
        files::remove_tree(&fs, "/srv/files/nope").await,
        Err(FsError::NotFound("/srv/files/nope".into()))
    );
    assert!(fs.stat("/srv/files/hello.txt").await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn changing_permissions_sets_exactly_the_bits_asked_for() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, root, _dir) = scratch(&sshd).await;
    sshd.run_as_tester(&format!(
        "cd '{root}' && echo x > script.sh && chmod 644 script.sh && mkdir dir"
    ));
    let script = files::join(&root, "script.sh");
    let dir = files::join(&root, "dir");

    fs.set_permissions(&script, 0o750).await.unwrap();
    fs.set_permissions(&dir, 0o1777).await.unwrap();

    assert_eq!(fs.stat(&script).await.unwrap().permissions, Some(0o750));
    assert_eq!(fs.stat(&dir).await.unwrap().permissions, Some(0o1777));
    assert_eq!(fs.stat(&script).await.unwrap().kind, FileKind::File);
    assert_eq!(
        fs.set_permissions("/srv/files/hello.txt", 0o777).await,
        Err(FsError::PermissionDenied("/srv/files/hello.txt".into()))
    );
    assert_eq!(
        fs.stat("/srv/files/hello.txt").await.unwrap().permissions,
        Some(0o640)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn changing_numeric_ownership_preserves_unspecified_ids_and_reports_denial() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, root, _dir) = scratch(&sshd).await;
    let path = files::join(&root, "owned");
    fs.create_empty_file(&path).await.unwrap();
    let get_ids = |command| sshd.run_as_tester(command).trim().parse::<u32>().unwrap();
    let uid = get_ids("id -u");
    let old_gid = get_ids("id -g");
    let gid = get_ids("getent group sftp-test | cut -d: -f3");
    assert_ne!(old_gid, gid);
    let before = fs.list_dir(&root).await.unwrap();
    assert_eq!((before[0].uid, before[0].gid), (Some(uid), Some(old_gid)));

    files::change_permissions(
        &fs,
        &path,
        PermissionChange {
            gid: Some(gid),
            ..PermissionChange::default()
        },
    )
    .await
    .unwrap();
    let after = fs.list_dir(&root).await.unwrap();
    assert_eq!((after[0].uid, after[0].gid), (Some(uid), Some(gid)));
    assert_eq!(after[0].permissions, before[0].permissions);

    files::change_permissions(
        &fs,
        &path,
        PermissionChange {
            uid: Some(uid),
            gid: Some(old_gid),
            ..PermissionChange::default()
        },
    )
    .await
    .unwrap();
    let restored = fs.list_dir(&root).await.unwrap();
    assert_eq!(
        (restored[0].uid, restored[0].gid),
        (Some(uid), Some(old_gid))
    );

    assert_eq!(
        files::change_permissions(
            &fs,
            &path,
            PermissionChange {
                uid: Some(0),
                ..PermissionChange::default()
            },
        )
        .await,
        Err(FsError::PermissionDenied(path))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn recursive_permissions_apply_to_the_tree_and_skip_links() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, root, _dir) = scratch(&sshd).await;
    sshd.run_as_tester(&format!(
        "cd '{root}' && mkdir -p tree/sub outside && touch tree/sub/file outside/keep \
         && chmod 755 tree tree/sub outside && chmod 644 tree/sub/file outside/keep \
         && ln -s ../outside tree/dir-link && ln -s ../outside/keep tree/file-link \
         && ln -s missing tree/dangling && ln -s outside top-link"
    ));

    files::change_permissions(
        &fs,
        &files::join(&root, "tree"),
        PermissionChange {
            mode: Some(0o700),
            scope: PermissionScope::Recursive,
            ..PermissionChange::default()
        },
    )
    .await
    .unwrap();
    files::change_permissions(
        &fs,
        &files::join(&root, "top-link/"),
        PermissionChange {
            mode: Some(0o700),
            scope: PermissionScope::Recursive,
            ..PermissionChange::default()
        },
    )
    .await
    .unwrap();

    for relative in ["tree", "tree/sub", "tree/sub/file"] {
        assert_eq!(
            fs.stat(&files::join(&root, relative))
                .await
                .unwrap()
                .permissions,
            Some(0o700)
        );
    }
    for (relative, expected) in [("outside", 0o755), ("outside/keep", 0o644)] {
        assert_eq!(
            fs.stat(&files::join(&root, relative))
                .await
                .unwrap()
                .permissions,
            Some(expected)
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn execute_only_adds_selected_bits_to_directories_and_preserves_files() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, root, _dir) = scratch(&sshd).await;
    sshd.run_as_tester(&format!(
        "cd '{root}' && mkdir -p tree/sub && touch tree/sub/file && chmod 1750 tree \
         && chmod 700 tree/sub && chmod 640 tree/sub/file"
    ));

    files::change_permissions(
        &fs,
        &files::join(&root, "tree"),
        PermissionChange {
            mode: Some(0o051),
            scope: PermissionScope::DirectoriesOnly,
            ..PermissionChange::default()
        },
    )
    .await
    .unwrap();

    for (relative, expected) in [
        ("tree", 0o1751),
        ("tree/sub", 0o711),
        ("tree/sub/file", 0o640),
    ] {
        assert_eq!(
            fs.stat(&files::join(&root, relative))
                .await
                .unwrap()
                .permissions,
            Some(expected)
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn exec_captures_stdout_stderr_and_status_on_the_existing_connection() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (connection, _dir) = connect(&sshd).await;
    let output = connection
        .exec("cat; printf 'stdout\\n'; printf 'stderr\\n' >&2; exit 23")
        .await
        .unwrap();
    assert_eq!(output.stdout, b"stdout\n");
    assert_eq!(output.stderr, b"stderr\n");
    assert_eq!(output.status, 23);

    let fs = connection.open_sftp().await.unwrap();
    assert_eq!(fs.home().await.unwrap(), "/home/tester");
}

#[tokio::test(flavor = "multi_thread")]
async fn archive_round_trips_special_names_and_both_operations_refuse_conflicts() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, root, _dir) = scratch(&sshd).await;
    let source_name = "-sp ace'\"\n$`[name]";
    let archive_name = "archive ' $ ` [name].tar.gz";
    let destination = files::join(&root, "archive ' $ ` [name]");
    let archive = files::join(&root, archive_name);
    let source = files::join(&root, source_name);
    fs.write_file(&source, b"special contents\0").await.unwrap();
    fs.create_dir(&files::join(&root, "dir")).await.unwrap();
    fs.write_file(&files::join(&root, "dir/file"), b"nested")
        .await
        .unwrap();

    fs.compress(&root, &[source_name.into(), "dir".into()], archive_name)
        .await
        .unwrap();
    let compressed = fs.read_file(&archive).await.unwrap();

    fs.write_file(&source, b"changed source").await.unwrap();
    assert_eq!(
        fs.compress(&root, &[source_name.into()], archive_name)
            .await,
        Err(FsError::AlreadyExists(archive.clone()))
    );
    assert_eq!(fs.read_file(&archive).await.unwrap(), compressed);

    fs.extract_archive(&root, archive_name).await.unwrap();
    let read = |name| files::join(&destination, name);
    assert_eq!(
        fs.read_file(&read(source_name)).await.unwrap(),
        b"special contents\0"
    );
    assert_eq!(fs.read_file(&read("dir/file")).await.unwrap(), b"nested");

    fs.write_file(&read("dir/file"), b"changed extracted file")
        .await
        .unwrap();
    assert_eq!(
        fs.extract_archive(&root, archive_name).await,
        Err(FsError::AlreadyExists(destination.clone()))
    );
    assert_eq!(
        fs.read_file(&read("dir/file")).await.unwrap(),
        b"changed extracted file"
    );
    assert_eq!(fs.read_file(&archive).await.unwrap(), compressed);
    assert_eq!(fs.list_dir(&root).await.unwrap().len(), 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_compression_has_one_winner_and_leaves_only_its_archive() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, root, _dir) = scratch(&sshd).await;
    fs.write_file(&files::join(&root, "first"), b"first")
        .await
        .unwrap();
    fs.write_file(&files::join(&root, "second"), b"second")
        .await
        .unwrap();
    let first = ["first".into()];
    let second = ["second".into()];
    let (a, b) = tokio::join!(
        fs.compress(&root, &first, "race.tar.gz"),
        fs.compress(&root, &second, "race.tar.gz")
    );
    let (winner, loser) = if a.is_ok() {
        ("first", b)
    } else {
        b.unwrap();
        ("second", a)
    };
    assert_eq!(
        loser,
        Err(FsError::AlreadyExists(files::join(&root, "race.tar.gz")))
    );
    assert_eq!(
        names(&fs.list_dir(&root).await.unwrap()),
        ["first", "race.tar.gz", "second"]
    );

    let (a, b) = tokio::join!(
        fs.extract_archive(&root, "race.tar.gz"),
        fs.extract_archive(&root, "race.tar.gz")
    );
    let loser = if a.is_ok() {
        b
    } else {
        b.unwrap();
        a
    };
    assert_eq!(
        loser,
        Err(FsError::AlreadyExists(files::join(&root, "race")))
    );
    assert_eq!(
        fs.read_file(&files::join(&root, &format!("race/{winner}")))
            .await
            .unwrap(),
        winner.as_bytes()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_unzip_reports_the_tool_and_leaves_no_destination() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, root, _dir) = scratch(&sshd).await;
    fs.write_file(&files::join(&root, "example.zip"), b"zip fixture")
        .await
        .unwrap();

    assert_eq!(
        fs.extract_archive(&root, "example.zip").await,
        Err(FsError::ArchiveToolMissing("unzip"))
    );
    assert_eq!(names(&fs.list_dir(&root).await.unwrap()), ["example.zip"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_extraction_reports_the_new_folder_without_deleting_it() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let (fs, root, _dir) = scratch(&sshd).await;
    let source = files::join(&root, "corrupt.tar");
    let target = files::join(&root, "corrupt");
    fs.write_file(&source, b"incomplete archive").await.unwrap();

    assert!(matches!(
        fs.extract_archive(&root, "corrupt.tar").await,
        Err(FsError::ArchiveIncomplete { path, .. }) if path == target
    ));
    assert_eq!(fs.lstat(&target).await.unwrap().kind, FileKind::Dir);
    assert_eq!(fs.read_file(&source).await.unwrap(), b"incomplete archive");
    assert_eq!(
        fs.extract_archive(&root, "corrupt.tar").await,
        Err(FsError::AlreadyExists(target))
    );
}
