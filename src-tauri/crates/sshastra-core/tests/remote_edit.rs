//! RemoteEdit: a remote file downloaded to a temp file, opened in the user's
//! editor, and uploaded again whenever it is saved. Uses a fake RemoteFs and
//! a recording Opener; the real OS file watcher on a temp directory. The last
//! test edits a file on a real OpenSSH server in Docker over SFTP.

mod support;

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use sshastra_core::edit::{
    EditError, EditEvent, EditOwner, EditSubscription, OpenEditOptions, Opener, RemoteEditor,
    MAX_EDIT_SIZE,
};
use sshastra_core::files::{
    FileEntry, FileKind, FileReader, FileStat, FileWriter, FsError, FsResult, RemoteFs,
    READ_FILE_LIMIT,
};
use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{
    BoxFuture, ConnectionManager, HostKeyDecision, HostKeyPrompt, PasswordPrompt, Prompter, Secret,
};
use support::Service;
use tokio::io::AsyncWrite;
use tokio::sync::mpsc;

/// Files by path, in memory. `failing` makes every write fail. Implements
/// only the streaming methods: the editor goes through `RemoteFs`'s
/// provided `read_file` / `write_file`.
#[derive(Default)]
struct FakeFs {
    files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    modified: Mutex<Option<u64>>,
    writes: Arc<Mutex<usize>>,
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

    fn change_remote(&self, path: &str, contents: &str, modified: Option<u64>) {
        self.files
            .lock()
            .unwrap()
            .insert(path.into(), contents.as_bytes().to_vec());
        *self.modified.lock().unwrap() = modified;
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
        Box::pin(async move {
            let stat = |kind, size| FileStat {
                kind,
                size,
                modified: *self.modified.lock().unwrap(),
                permissions: Some(0o644),
            };
            if path == "/etc" {
                return Ok(stat(FileKind::Dir, 4096));
            }
            let size = self.files.lock().unwrap().get(path).map(|d| d.len() as u64);
            size.map(|size| stat(FileKind::File, size))
                .ok_or_else(|| FsError::NotFound(path.into()))
        })
    }

    fn open_read_at<'a>(
        &'a self,
        path: &'a str,
        offset: u64,
    ) -> BoxFuture<'a, FsResult<FileReader>> {
        Box::pin(async move {
            let data = self
                .files
                .lock()
                .unwrap()
                .get(path)
                .cloned()
                .ok_or_else(|| FsError::NotFound(path.into()))?;
            let mut cursor = io::Cursor::new(data);
            cursor.set_position(offset);
            Ok(Box::new(cursor) as FileReader)
        })
    }

    fn open_write_at<'a>(&'a self, _: &'a str, _: u64) -> BoxFuture<'a, FsResult<FileWriter>> {
        unimplemented!("Remote edit does not resume staged writes")
    }

    fn create_new<'a>(&'a self, _: &'a str, _: bool) -> BoxFuture<'a, FsResult<FileWriter>> {
        unimplemented!("Remote edit does not stage writes")
    }
    fn create_write<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileWriter>> {
        Box::pin(async move {
            if *self.failing.lock().unwrap() {
                return Err(FsError::Protocol("connection lost".into()));
            }
            Ok(Box::new(FakeWriter {
                files: Arc::clone(&self.files),
                writes: Arc::clone(&self.writes),
                path: path.into(),
                data: Vec::new(),
            }) as FileWriter)
        })
    }

    // Remote editing never changes the tree.

    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, FsResult<FileStat>> {
        self.stat(path)
    }

    fn create_dir<'a>(&'a self, _: &'a str) -> BoxFuture<'a, FsResult<()>> {
        unused()
    }

    fn rename<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, FsResult<()>> {
        unused()
    }

    fn remove_file<'a>(&'a self, _: &'a str) -> BoxFuture<'a, FsResult<()>> {
        unused()
    }

    fn remove_dir<'a>(&'a self, _: &'a str) -> BoxFuture<'a, FsResult<()>> {
        unused()
    }

    fn set_permissions<'a>(&'a self, _: &'a str, _: u32) -> BoxFuture<'a, FsResult<()>> {
        unused()
    }
}

/// Stores its file when shut down, as a closed SFTP handle would.
struct FakeWriter {
    files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    writes: Arc<Mutex<usize>>,
    path: String,
    data: Vec<u8>,
}

impl AsyncWrite for FakeWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.data.extend_from_slice(buf);
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        *self.writes.lock().unwrap() += 1;
        let data = self.data.clone();
        self.files.lock().unwrap().insert(self.path.clone(), data);
        Poll::Ready(Ok(()))
    }
}

fn unused<'a>() -> BoxFuture<'a, FsResult<()>> {
    Box::pin(async { Err(FsError::Protocol("not used by remote editing".into())) })
}

/// Records what it was asked to open; fails if `refuse` is set.
#[derive(Default)]
struct RecordingOpener {
    opened: Mutex<Vec<PathBuf>>,
    refuse: bool,
    application_opens: Mutex<Vec<(PathBuf, PathBuf)>>,
    refuse_application: bool,
}

impl Opener for RecordingOpener {
    fn open(&self, path: &Path) -> Result<(), String> {
        if self.refuse {
            return Err("no application can open this file".into());
        }
        self.opened.lock().unwrap().push(path.to_owned());
        Ok(())
    }

    fn open_application(&self, path: &Path, application: &Path) -> Result<(), String> {
        self.application_opens
            .lock()
            .unwrap()
            .push((path.to_owned(), application.to_owned()));
        if self.refuse_application {
            return Err("selected application unavailable".into());
        }
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
async fn opening_and_reopening_use_the_chosen_application_and_keep_one_temp_file() {
    let s = setup();
    let fs = FakeFs::with("/etc/app.conf", "port = 80\n");
    let id = s
        .editor
        .open_with(
            fs.clone(),
            &host(),
            "/etc/app.conf",
            OpenEditOptions {
                application: Some(Path::new("An Editor")),
                ..OpenEditOptions::default()
            },
            |_| {},
        )
        .await
        .unwrap()
        .id;
    let local = s.editor.local_path(id).unwrap();
    assert_eq!(std::fs::read_to_string(&local).unwrap(), "port = 80\n");

    let shown = s
        .editor
        .open_with(
            fs,
            &host(),
            "/etc/app.conf",
            OpenEditOptions {
                application: Some(Path::new("Another Editor")),
                ..OpenEditOptions::default()
            },
            |_| {},
        )
        .await
        .unwrap();
    assert_eq!(shown.id, id);
    assert!(!shown.application_fallback);
    assert_eq!(
        *s.opener.application_opens.lock().unwrap(),
        [
            (local.clone(), PathBuf::from("An Editor")),
            (local, PathBuf::from("Another Editor")),
        ]
    );
    assert!(s.opener.opened.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unavailable_application_falls_back_and_the_edit_keeps_uploading() {
    let s = setup_with(RecordingOpener {
        refuse_application: true,
        ..RecordingOpener::default()
    });
    let fs = FakeFs::with("/etc/app.conf", "port = 80\n");
    let (on_event, mut rx) = events();
    let opened = s
        .editor
        .open_with(
            fs.clone(),
            &host(),
            "/etc/app.conf",
            OpenEditOptions {
                application: Some(Path::new("Missing Editor")),
                ..OpenEditOptions::default()
            },
            on_event,
        )
        .await
        .unwrap();

    let local = s.editor.local_path(opened.id).unwrap();
    assert_eq!(
        s.opener.opened.lock().unwrap().as_slice(),
        [local.as_path()]
    );
    assert!(opened.application_fallback);

    save(&local, "port = 8080\n").await;
    assert_eq!(next(&mut rx).await, EditEvent::Uploading);
    assert_eq!(next(&mut rx).await, EditEvent::Uploaded);
    assert_eq!(fs.contents("/etc/app.conf"), "port = 8080\n");
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
async fn a_remote_change_blocks_uploads_until_explicitly_overwritten() {
    let s = setup();
    let path = "/etc/app.conf";
    let fs = FakeFs::with(path, "original\n");
    fs.change_remote(path, "original\n", Some(1));
    let (on_event, mut rx) = events();
    let id = s
        .editor
        .open(fs.clone(), &host(), path, on_event)
        .await
        .unwrap();
    let local = s.editor.local_path(id).unwrap();
    // Only the timestamp changes: both versions are the same length.
    fs.change_remote(path, "remotely\n", Some(2));
    save(&local, "local work\n").await;

    assert_eq!(next(&mut rx).await, EditEvent::Uploading);
    let EditEvent::Conflict {
        conflict_id,
        reason: None,
    } = next(&mut rx).await
    else {
        panic!("expected a conflict");
    };
    assert_eq!(fs.writes(), 0);
    assert_eq!(fs.contents(path), "remotely\n");

    save(&local, "more local work\n").await;
    s.editor.retry(id).unwrap();
    assert!(tokio::time::timeout(DEBOUNCE * 3, rx.recv()).await.is_err());
    assert_eq!(fs.writes(), 0);

    s.editor.overwrite(id, conflict_id).unwrap();
    assert_eq!(next(&mut rx).await, EditEvent::Uploading);
    assert_eq!(next(&mut rx).await, EditEvent::Uploaded);
    assert_eq!(fs.contents(path), "more local work\n");

    save(&local, "next save\n").await;
    assert_eq!(next(&mut rx).await, EditEvent::Uploading);
    assert_eq!(next(&mut rx).await, EditEvent::Uploaded);
    assert_eq!(fs.contents(path), "next save\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn opening_the_remote_version_keeps_both_edits_live_and_independent() {
    let s = setup_with(RecordingOpener {
        refuse_application: true,
        ..RecordingOpener::default()
    });
    let path = "/etc/app.conf";
    let fs = FakeFs::with(path, "a\n");
    let (on_change, mut original_events) = events();
    let original = s
        .editor
        .open(fs.clone(), &host(), path, on_change)
        .await
        .unwrap();
    let original_local = s.editor.local_path(original).unwrap();

    // Only the size changes.
    fs.change_remote(path, "remote version\n", None);
    save(&original_local, "my version\n").await;
    assert_eq!(next(&mut original_events).await, EditEvent::Uploading);
    let EditEvent::Conflict { conflict_id, .. } = next(&mut original_events).await else {
        panic!("expected a conflict");
    };

    let (on_copy, mut copy_events) = events();
    let copy = s
        .editor
        .open_conflict_copy(
            original,
            conflict_id,
            Some(Path::new("Missing Editor")),
            on_copy,
        )
        .await
        .unwrap();
    let copy_local = s.editor.local_path(copy.id).unwrap();
    assert_ne!(original_local, copy_local);
    assert!(copy.application_fallback);
    assert_eq!(
        s.opener.opened.lock().unwrap().as_slice(),
        [original_local.as_path(), copy_local.as_path()]
    );
    assert_eq!(
        std::fs::read_to_string(&copy_local).unwrap(),
        "remote version\n"
    );
    assert_eq!(
        std::fs::read_to_string(&original_local).unwrap(),
        "my version\n"
    );
    assert_eq!(fs.writes(), 0);

    save(&copy_local, "remote version revised\n").await;
    assert_eq!(next(&mut copy_events).await, EditEvent::Uploading);
    assert_eq!(next(&mut copy_events).await, EditEvent::Uploaded);
    assert_eq!(fs.contents(path), "remote version revised\n");

    // An app upload that leaves size and mtime unchanged still invalidates the sibling.
    save(&original_local, "original version edits\n").await;
    s.editor.overwrite(original, conflict_id).unwrap();
    assert_eq!(next(&mut original_events).await, EditEvent::Uploading);
    assert_eq!(next(&mut original_events).await, EditEvent::Uploaded);
    save(&copy_local, "next version\n").await;
    assert_eq!(next(&mut copy_events).await, EditEvent::Uploading);
    assert!(matches!(
        next(&mut copy_events).await,
        EditEvent::Conflict { .. }
    ));
    assert_eq!(fs.contents(path), "original version edits\n");
    assert!(s.editor.close(original));
    assert!(copy_local.exists());
    assert!(s.editor.close(copy.id));
    assert!(!copy_local.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_overwrite_leaves_the_edit_paused_and_requires_a_fresh_choice() {
    let s = setup();
    let path = "/etc/app.conf";
    let fs = FakeFs::with(path, "a\n");
    let (on_event, mut rx) = events();
    let id = s
        .editor
        .open(fs.clone(), &host(), path, on_event)
        .await
        .unwrap();
    let local = s.editor.local_path(id).unwrap();
    fs.change_remote(path, "remote\n", None);
    fs.fail_writes(true);
    save(&local, "local\n").await;
    assert_eq!(next(&mut rx).await, EditEvent::Uploading);
    let EditEvent::Conflict { conflict_id, .. } = next(&mut rx).await else {
        panic!("expected a conflict");
    };

    s.editor.overwrite(id, conflict_id).unwrap();
    assert_eq!(next(&mut rx).await, EditEvent::Uploading);
    let EditEvent::Conflict {
        conflict_id: next_conflict,
        reason: Some(reason),
    } = next(&mut rx).await
    else {
        panic!("expected a conflict with the overwrite error");
    };
    assert!(reason.contains("connection lost"));
    assert_eq!(
        s.editor.overwrite(id, conflict_id),
        Err(EditError::ConflictExpired)
    );
    assert_eq!(fs.contents(path), "remote\n");

    fs.fail_writes(false);
    s.editor.overwrite(id, next_conflict).unwrap();
    assert_eq!(next(&mut rx).await, EditEvent::Uploading);
    assert_eq!(next(&mut rx).await, EditEvent::Uploaded);
    assert_eq!(fs.contents(path), "local\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn saving_does_not_recreate_a_file_that_vanished_on_the_host() {
    let s = setup();
    let path = "/etc/app.conf";
    let fs = FakeFs::with(path, "a\n");
    let (on_event, mut rx) = events();
    let id = s
        .editor
        .open(fs.clone(), &host(), path, on_event)
        .await
        .unwrap();
    let local = s.editor.local_path(id).unwrap();
    fs.files.lock().unwrap().remove(path);

    save(&local, "local\n").await;

    assert_eq!(next(&mut rx).await, EditEvent::Uploading);
    assert!(
        matches!(next(&mut rx).await, EditEvent::UploadFailed { reason } if reason.contains("no such file"))
    );
    assert!(matches!(fs.stat(path).await, Err(FsError::NotFound(_))));
    assert_eq!(fs.writes(), 0);
    assert_eq!(std::fs::read_to_string(&local).unwrap(), "local\n");
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
async fn a_shared_edit_replays_conflicts_and_survives_the_first_owner_closing() {
    let s = setup();
    let path = "/etc/app.conf";
    let fs = FakeFs::with(path, "original");
    let first_owner = EditOwner::default();
    let second_owner = EditOwner::default();
    let unrelated = EditOwner::default();
    let (first_sink, mut first_events) = events();
    let first = s
        .editor
        .open_subscribed(
            fs.clone(),
            &host(),
            path,
            OpenEditOptions::default(),
            EditSubscription::new(&first_owner, first_sink),
        )
        .await
        .unwrap();
    let local = s.editor.local_path(first.id).unwrap();

    fs.change_remote(path, "remote", Some(2));
    save(&local, "local work").await;
    assert_eq!(next(&mut first_events).await, EditEvent::Uploading);
    let conflict = next(&mut first_events).await;
    let EditEvent::Conflict { conflict_id, .. } = conflict else {
        panic!("expected a conflict");
    };
    assert_eq!(
        s.editor.overwrite_owned(first.id, conflict_id, &unrelated),
        Err(EditError::NotOpen)
    );

    let (second_sink, mut second_events) = events();
    let second = s
        .editor
        .open_subscribed(
            fs.clone(),
            &host(),
            path,
            OpenEditOptions::default(),
            EditSubscription::new(&second_owner, second_sink),
        )
        .await
        .unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(next(&mut second_events).await, conflict);
    s.editor.close_owner(&first_owner);
    assert!(local.exists());
    assert!(first_events.recv().await.is_none());

    s.editor
        .overwrite_owned(second.id, conflict_id, &second_owner)
        .unwrap();
    assert_eq!(next(&mut second_events).await, EditEvent::Uploading);
    assert_eq!(next(&mut second_events).await, EditEvent::Uploaded);
    assert_eq!(fs.contents(path), "local work");
    s.editor.release(second.id, &second_owner);
    assert!(!local.exists());

    assert!(matches!(
        s.editor
            .open_subscribed(
                fs,
                &host(),
                path,
                OpenEditOptions::default(),
                EditSubscription::new(&first_owner, |_| {}),
            )
            .await,
        Err(EditError::NotOpen)
    ));
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

#[tokio::test(flavor = "multi_thread")]
async fn a_file_over_the_size_limit_is_not_opened() {
    let s = setup();
    let fs = FakeFs::with("/var/log/big.log", "");
    fs.files.lock().unwrap().insert(
        "/var/log/big.log".into(),
        vec![b'x'; MAX_EDIT_SIZE as usize + 1],
    );

    let opened = s.editor.open(fs, &host(), "/var/log/big.log", |_| {}).await;

    assert!(
        matches!(opened, Err(EditError::Fs(FsError::TooLarge { .. }))),
        "{opened:?}"
    );
    assert!(s.opener.opened.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn read_file_refuses_more_than_its_limit() {
    let fs = FakeFs::with("/big", "");
    fs.files
        .lock()
        .unwrap()
        .insert("/big".into(), vec![b'x'; READ_FILE_LIMIT as usize + 1]);

    assert!(matches!(
        fs.read_file("/big").await,
        Err(FsError::TooLarge { .. })
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_with_nul_bytes_is_opened_only_when_asked_to() {
    let s = setup();
    let fs = FakeFs::with("/bin/tool", "\x7fELF\0\0\0");

    let refused = s
        .editor
        .open(fs.clone(), &host(), "/bin/tool", |_| {})
        .await;
    assert!(matches!(refused, Err(EditError::Binary)), "{refused:?}");
    assert!(s.opener.opened.lock().unwrap().is_empty());

    let id = s
        .editor
        .open_binary(fs, &host(), "/bin/tool", |_| {})
        .await
        .unwrap();
    assert!(s.editor.local_path(id).unwrap().exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn only_regular_files_are_opened() {
    let s = setup();
    let fs = FakeFs::with("/etc/app.conf", "a\n");

    let opened = s.editor.open(fs, &host(), "/etc", |_| {}).await;

    assert!(matches!(opened, Err(EditError::NotAFile)), "{opened:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_run_deletes_the_folders_runs_that_ended_left_behind() {
    let base = tempfile::tempdir().unwrap();
    // A run that crashed: its folder (and lock file) are still there.
    let crashed = base.path().join("crashed-run");
    std::fs::create_dir_all(crashed.join("host-1").join("1")).unwrap();
    std::fs::write(crashed.join(".lock"), "").unwrap();
    std::fs::write(crashed.join("host-1").join("1").join("app.conf"), "a").unwrap();

    let editor = RemoteEditor::start(base.path(), Arc::new(RecordingOpener::default())).unwrap();

    assert!(!crashed.exists());
    let fs = FakeFs::with("/etc/app.conf", "a\n");
    let id = editor
        .open(fs, &host(), "/etc/app.conf", |_| {})
        .await
        .unwrap();
    let local = editor.local_path(id).unwrap();
    assert!(local.starts_with(base.path()));
    assert!(!local.starts_with(&crashed));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_running_editor_keeps_its_folder_when_another_run_starts() {
    let base = tempfile::tempdir().unwrap();
    let first = RemoteEditor::start(base.path(), Arc::new(RecordingOpener::default())).unwrap();
    let fs = FakeFs::with("/etc/app.conf", "a\n");
    let id = first
        .open(fs, &host(), "/etc/app.conf", |_| {})
        .await
        .unwrap();
    let local = first.local_path(id).unwrap();

    let second = RemoteEditor::start(base.path(), Arc::new(RecordingOpener::default())).unwrap();
    assert!(local.exists());

    // Exiting deletes only the exiting run's folder.
    second.close_all();
    assert!(local.exists());
    first.close_all();
    assert!(!local.exists());
}

struct Trusting(&'static str);

impl Prompter for Trusting {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, HostKeyDecision> {
        Box::pin(async { HostKeyDecision::SaveAndTrust })
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
        tags: Vec::new(),
        icon: None,
        detected_os: None,
        color: None,
        address: sshd.host.clone(),
        port: sshd.port,
        user: sshd.user.into(),
        auth: HostAuth::Password,
        jump_host: None,
        group_id: None,
        terminal_scheme: None,
        identities_only: false,
        forward_agent: false,
        allow_legacy_algorithms: false,
        open_on_startup: false,
        agent_access: Default::default(),
        proxy: Default::default(),
        keepalive_seconds: None,
        post_login_command: None,
        terminal_charset: None,
        terminal_backspace: None,
        default_directory: None,
        forwards: Vec::new(),
        bookmarks: Vec::new(),
        open_ssh_source: None,
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
