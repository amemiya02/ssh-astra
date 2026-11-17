//! File operations (new folder, rename, delete, chmod) through SftpFs against
//! a real OpenSSH server in Docker. Each test works in its own scratch
//! directory under tester's home; the shared `/srv/files` tree is only used
//! for operations that must fail (it is root-owned). Skipped when Docker is
//! unavailable.

mod support;

use std::sync::Arc;

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

/// An SftpFs on the `ssh` server plus a fresh, empty scratch directory for
/// this test (absolute path), and the temp dir holding the known_hosts.
async fn scratch(sshd: &Sshd) -> (SftpFs, String, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let manager = ConnectionManager::new(KnownHosts::new(dir.path().join("known_hosts")));
    let host = Host {
        id: HostId::from("sftp-ops".to_owned()),
        name: "sftp-ops".into(),
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
    assert_eq!(
        files::remove_tree(&fs, "/srv/files/docs").await,
        Err(FsError::PermissionDenied("/srv/files/docs".into()))
    );
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
