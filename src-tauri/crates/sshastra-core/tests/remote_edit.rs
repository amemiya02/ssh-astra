//! RemoteEdit: a remote file downloaded to a temp file, opened in the user's
//! editor, and uploaded again whenever it is saved. Uses a fake RemoteFs and
//! a recording Opener; the real OS file watcher on a temp directory. The last
//! test edits a file on a real OpenSSH server in Docker over SFTP.

mod support;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sshastra_core::edit::{EditError, EditEvent, Opener, RemoteEditor};
use sshastra_core::files::{FileEntry, FileStat, FsError, FsResult, RemoteFs};
use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{
    BoxFuture, ConnectionManager, HostKeyPrompt, PasswordPrompt, Prompter, Secret,
};
use support::Service;
use tokio::sync::mpsc;

/// Files by path, in memory. `failing` makes every write fail.
#[derive(Default)]
struct FakeFs {
    files: Mutex<HashMap<String, Vec<u8>>>,
    writes: Mutex<usize>,
    failing: Mutex<bool>,
}

impl FakeFs {
    fn with(path: &str, contents: &str) -> Arc<Self> {
        let fs = Self::default();
        fs.files
            .lock()
            .unwrap()
            .insert(path.into(), contents.as_bytes().to_vec());
        Arc::new(fs)
    }

    fn contents(&self, path: &str) -> String {
        String::from_utf8(self.files.lock().unwrap()[path].clone()).unwrap()
    }

    fn writes(&self) -> usize {
        *self.writes.lock().unwrap()
    }

    fn fail_writes(&self, failing: bool) {
        *self.failing.lock().unwrap() = failing;
    }
}

impl RemoteFs for FakeFs {
    fn home(&self) -> BoxFuture<'_, FsResult<String>> {
        Box::pin(async { Ok("/home/me".into()) })
    }

    fn canonicalize<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<String>> {
        Box::pin(async move { Ok(path.into()) })
    }

    fn list_dir<'a>(&'a self, _: &'a str) -> BoxFuture<'a, FsResult<Vec<FileEntry>>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileStat>> {
        Box::pin(async move { Err(FsError::NotFound(path.into())) })
    }

    fn read_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<Vec<u8>>> {
        Box::pin(async move {
            self.files
                .lock()
                .unwrap()
                .get(path)
                .cloned()
                .ok_or_else(|| FsError::NotFound(path.into()))
        })
    }

    fn write_file<'a>(&'a self, path: &'a str, data: &'a [u8]) -> BoxFuture<'a, FsResult<()>> {
        Box::pin(async move {
            if *self.failing.lock().unwrap() {
                return Err(FsError::Protocol("connection lost".into()));
            }
            *self.writes.lock().unwrap() += 1;
            self.files
                .lock()
                .unwrap()
                .insert(path.into(), data.to_vec());
            Ok(())
        })
    }
}

/// Records what it was asked to open; fails if `refuse` is set.
#[derive(Default)]
struct RecordingOpener {
    opened: Mutex<Vec<PathBuf>>,
    refuse: bool,
}

impl Opener for RecordingOpener {
    fn open(&self, path: &Path) -> Result<(), String> {
        if self.refuse {
            return Err("no application can open this file".into());
        }
        self.opened.lock().unwrap().push(path.to_owned());
        Ok(())
    }
}

const DEBOUNCE: Duration = Duration::from_millis(150);

struct Setup {
    root: tempfile::TempDir,
    opener: Arc<RecordingOpener>,
    editor: RemoteEditor,
}

fn setup() -> Setup {
    setup_with(RecordingOpener::default())
}

fn setup_with(opener: RecordingOpener) -> Setup {
    let root = tempfile::tempdir().unwrap();
    let opener = Arc::new(opener);
    let editor =
        RemoteEditor::new(root.path().join("edit"), opener.clone()).with_debounce(DEBOUNCE);
    Setup {
        root,
        opener,
        editor,
    }
}

fn host() -> HostId {
    HostId::from("host-1".to_owned())
}

/// The events of one edit, as a stream.
fn events() -> (
    impl Fn(EditEvent) + Send + Sync + 'static,
    mpsc::UnboundedReceiver<EditEvent>,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    (move |e| drop(tx.send(e)), rx)
}

async fn next(rx: &mut mpsc::UnboundedReceiver<EditEvent>) -> EditEvent {
    tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("no edit event within 10 s")
        .expect("the edit stopped")
}

/// Saves like an editor does after a moment, so the watcher has started.
async fn save(path: &Path, contents: &str) {
    tokio::time::sleep(Duration::from_millis(300)).await;
    std::fs::write(path, contents).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn opening_downloads_the_file_and_opens_it_in_the_editor() {
    let s = setup();
    let fs = FakeFs::with("/etc/app.conf", "port = 80\n");
    let (on_event, _rx) = events();

    let id = s
        .editor
        .open(fs, &host(), "/etc/app.conf", on_event)
        .await
        .unwrap();

    let local = s.editor.local_path(id).unwrap();
    assert_eq!(local.file_name().unwrap(), "app.conf");
    assert!(local.starts_with(s.root.path().join("edit").join("host-1")));
    assert_eq!(std::fs::read_to_string(&local).unwrap(), "port = 80\n");
    assert_eq!(*s.opener.opened.lock().unwrap(), [local]);
}

#[tokio::test(flavor = "multi_thread")]
async fn saving_the_temp_file_uploads_it() {
    let s = setup();
    let fs = FakeFs::with("/etc/app.conf", "port = 80\n");
    let (on_event, mut rx) = events();
    let id = s
        .editor
        .open(fs.clone(), &host(), "/etc/app.conf", on_event)
        .await
        .unwrap();

    save(&s.editor.local_path(id).unwrap(), "port = 8080\n").await;

    assert_eq!(next(&mut rx).await, EditEvent::Uploading);
    assert_eq!(next(&mut rx).await, EditEvent::Uploaded);
    assert_eq!(fs.contents("/etc/app.conf"), "port = 8080\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_burst_of_writes_is_uploaded_once() {
    let s = setup();
    let fs = FakeFs::with("/etc/app.conf", "a\n");
    let (on_event, mut rx) = events();
    let id = s
        .editor
        .open(fs.clone(), &host(), "/etc/app.conf", on_event)
        .await
        .unwrap();
    let local = s.editor.local_path(id).unwrap();

    save(&local, "b\n").await;
    for contents in ["c\n", "d\n", "e\n"] {
        tokio::time::sleep(DEBOUNCE / 5).await;
        std::fs::write(&local, contents).unwrap();
    }

    assert_eq!(next(&mut rx).await, EditEvent::Uploading);
    assert_eq!(next(&mut rx).await, EditEvent::Uploaded);
    tokio::time::sleep(DEBOUNCE * 3).await;
    assert_eq!(fs.writes(), 1);
    assert_eq!(fs.contents("/etc/app.conf"), "e\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_upload_is_reported_and_can_be_retried() {
    let s = setup();
    let fs = FakeFs::with("/etc/app.conf", "a\n");
    let (on_event, mut rx) = events();
    let id = s
        .editor
        .open(fs.clone(), &host(), "/etc/app.conf", on_event)
        .await
        .unwrap();
    fs.fail_writes(true);

    save(&s.editor.local_path(id).unwrap(), "b\n").await;

    assert_eq!(next(&mut rx).await, EditEvent::Uploading);
    assert!(matches!(
        next(&mut rx).await,
        EditEvent::UploadFailed { reason } if reason.contains("connection lost")
    ));
    assert_eq!(fs.contents("/etc/app.conf"), "a\n");

    fs.fail_writes(false);
    s.editor.retry(id).unwrap();

    assert_eq!(next(&mut rx).await, EditEvent::Uploading);
    assert_eq!(next(&mut rx).await, EditEvent::Uploaded);
    assert_eq!(fs.contents("/etc/app.conf"), "b\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_an_edit_deletes_its_temp_file_and_stops_uploading() {
    let s = setup();
    let fs = FakeFs::with("/etc/app.conf", "a\n");
    let (on_event, mut rx) = events();
    let id = s
        .editor
        .open(fs.clone(), &host(), "/etc/app.conf", on_event)
        .await
        .unwrap();
    let local = s.editor.local_path(id).unwrap();

    assert!(s.editor.close(id));

    assert!(!local.exists());
    assert!(!local.parent().unwrap().exists());
    assert_eq!(s.editor.local_path(id), None);
    assert!(s.editor.retry(id).is_err());
    assert!(!s.editor.close(id));
    tokio::time::timeout(Duration::from_secs(5), async {
        while rx.recv().await.is_some() {}
    })
    .await
    .expect("the edit's events end once it is closed");
    assert_eq!(fs.writes(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_everything_deletes_the_whole_temp_directory() {
    let s = setup();
    let a = FakeFs::with("/a.txt", "a\n");
    let b = FakeFs::with("/b.txt", "b\n");
    let other = HostId::from("host-2".to_owned());
    s.editor.open(a, &host(), "/a.txt", |_| {}).await.unwrap();
    s.editor.open(b, &other, "/b.txt", |_| {}).await.unwrap();

    s.editor.close_all();

    assert!(!s.root.path().join("edit").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn opening_a_file_that_is_already_open_shows_the_same_edit_again() {
    let s = setup();
    let fs = FakeFs::with("/etc/app.conf", "a\n");
    let first = s
        .editor
        .open(fs.clone(), &host(), "/etc/app.conf", |_| {})
        .await
        .unwrap();
    std::fs::write(s.editor.local_path(first).unwrap(), "unsaved upload\n").unwrap();

    let second = s
        .editor
        .open(fs.clone(), &host(), "/etc/app.conf", |_| {})
        .await
        .unwrap();

    assert_eq!(first, second);
    let local = s.editor.local_path(first).unwrap();
    assert_eq!(std::fs::read_to_string(&local).unwrap(), "unsaved upload\n");
    assert_eq!(*s.opener.opened.lock().unwrap(), [local.clone(), local]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_no_application_can_open_leaves_nothing_behind() {
    let s = setup_with(RecordingOpener {
        refuse: true,
        ..Default::default()
    });
    let fs = FakeFs::with("/etc/app.conf", "a\n");

    let opened = s.editor.open(fs, &host(), "/etc/app.conf", |_| {}).await;

    assert!(matches!(opened, Err(EditError::Open(_))));
    let host_dir = s.root.path().join("edit").join("host-1");
    assert_eq!(
        std::fs::read_dir(host_dir).map(|d| d.count()).unwrap_or(0),
        0
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_remote_file_is_not_opened() {
    let s = setup();
    let fs = FakeFs::with("/etc/app.conf", "a\n");

    let opened = s.editor.open(fs, &host(), "/etc/nope", |_| {}).await;

    assert!(matches!(opened, Err(EditError::Fs(FsError::NotFound(_)))));
    assert!(s.opener.opened.lock().unwrap().is_empty());
}

struct Trusting(&'static str);

impl Prompter for Trusting {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, bool> {
        Box::pin(async { true })
    }

    fn password(&self, _: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        Box::pin(async move { Some(Secret::new(self.0)) })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn saving_the_temp_file_changes_the_file_on_the_server() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let s = setup();
    let manager = ConnectionManager::new(KnownHosts::new(s.root.path().join("known_hosts")));
    let host = Host {
        id: host(),
        name: "edit".into(),
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
    let fs: Arc<dyn RemoteFs> = Arc::new(connection.open_sftp().await.unwrap());
    let remote = format!("/home/tester/edit-{}.conf", uuid::Uuid::new_v4());
    fs.write_file(&remote, b"port = 80\n").await.unwrap();
    let (on_event, mut rx) = events();

    let id = s
        .editor
        .open(fs.clone(), &host.id, &remote, on_event)
        .await
        .unwrap();
    let local = s.editor.local_path(id).unwrap();
    assert_eq!(std::fs::read_to_string(&local).unwrap(), "port = 80\n");
    save(&local, "port = 8080\n").await;

    assert_eq!(next(&mut rx).await, EditEvent::Uploading);
    assert_eq!(next(&mut rx).await, EditEvent::Uploaded);
    assert_eq!(fs.read_file(&remote).await.unwrap(), b"port = 8080\n");

    s.editor.close(id);
    assert!(!local.exists());
}
