//! TransferQueue between the local disk and a real OpenSSH server in Docker:
//! a nested folder round trip and resuming an upload across a dropped
//! Connection. Skipped when Docker is unavailable.

mod support;

use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sshastra_core::files::{
    ConflictAnswer, DiskFs, OpenRemote, RemoteFs, Transfer, TransferQueue, TransferState,
};
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

fn endpoint(sshd: &Sshd, dir: &Path) -> (ConnectionManager, Host) {
    let manager = ConnectionManager::new(KnownHosts::new(dir.join("known_hosts")));
    let host = Host {
        id: HostId::from("transfer".to_owned()),
        name: "transfer".into(),
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
        default_directory: None,
        forwards: Vec::new(),
    };
    (manager, host)
}

async fn remote(sshd: &Sshd, dir: &Path) -> Arc<dyn RemoteFs> {
    let (manager, host) = endpoint(sshd, dir);
    let connection = manager
        .connect(&host, Arc::new(Trusting(sshd.password)))
        .await
        .unwrap();
    Arc::new(connection.open_sftp().await.unwrap())
}

/// Every file under `root`, relative, with its contents; and every folder.
fn tree(root: &Path) -> (Vec<(PathBuf, Vec<u8>)>, Vec<PathBuf>) {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let rel = path.strip_prefix(root).unwrap().to_path_buf();
            if path.is_dir() {
                dirs.push(rel);
                stack.push(path);
            } else {
                files.push((rel, std::fs::read(&path).unwrap()));
            }
        }
    }
    files.sort();
    dirs.sort();
    (files, dirs)
}

async fn settle(queue: &TransferQueue) {
    let wait = async {
        loop {
            let all = queue.list();
            if all.iter().all(|t| t.state == TransferState::Done) {
                return;
            }
            if let Some(t) = all.iter().find(|t| {
                matches!(
                    t.state,
                    TransferState::Failed { .. } | TransferState::Cancelled
                )
            }) {
                panic!("transfer stopped: {t:#?}");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(60), wait)
        .await
        .expect("transfers finish");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_nested_folder_survives_an_upload_and_a_download() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let scratch = tempfile::tempdir().unwrap();
    let fs = remote(&sshd, scratch.path()).await;

    let up = scratch.path().join("up");
    let site = up.join("site");
    std::fs::create_dir_all(site.join("assets/img")).unwrap();
    std::fs::create_dir_all(site.join("empty")).unwrap();
    std::fs::write(site.join("index.html"), "<h1>hi</h1>").unwrap();
    std::fs::write(site.join("assets/app.js"), "console.log(1)").unwrap();
    // Bigger than one copy chunk and than one SFTP packet.
    let big: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(site.join("assets/img/big.bin"), &big).unwrap();
    std::fs::write(site.join("assets/img/empty.txt"), "").unwrap();

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let remote_dir = format!("/home/tester/transfer-{unique}");
    fs.create_dir(&remote_dir).await.unwrap();

    let queue = TransferQueue::new(Arc::new(DiskFs), |_| {});
    let opener: OpenRemote = {
        let fs = Arc::clone(&fs);
        Arc::new(move || {
            let fs = Arc::clone(&fs);
            Box::pin(async move { Ok(fs) })
        })
    };

    queue.upload(opener.clone(), site.clone(), remote_dir.clone());
    settle(&queue).await;

    let mut listing: Vec<_> = fs
        .list_dir(&format!("{remote_dir}/site"))
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    listing.sort();
    assert_eq!(listing, ["assets", "empty", "index.html"]);

    let down = scratch.path().join("down");
    std::fs::create_dir(&down).unwrap();
    let id = queue.download(opener, format!("{remote_dir}/site"), down.clone());
    settle(&queue).await;

    let (up_files, up_dirs) = tree(&site);
    let (down_files, down_dirs) = tree(&down.join("site"));
    assert_eq!(up_files.len(), 4);
    assert_eq!(down_dirs, up_dirs);
    assert_eq!(down_files, up_files);
    let t = queue.list().into_iter().find(|t| t.id == id).unwrap();
    assert_eq!((t.files_done, t.files_total), (4, 4));
    assert_eq!(t.bytes_done, big.len() as u64 + 11 + 14);
}

async fn wait_until(queue: &TransferQueue, condition: impl Fn(&Transfer) -> bool) -> Transfer {
    tokio::time::timeout(Duration::from_secs(50), async {
        loop {
            let transfer = queue.list().into_iter().next().unwrap();
            if condition(&transfer) {
                break transfer;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("transfer did not reach expected state: {:?}", queue.list()))
}

/// Count what actually crossed the server's network interface, including SSH overhead.
fn received_bytes(sshd: &Sshd) -> u64 {
    sshd.run_as_tester(
        r#"awk '$1 ~ /eth[0-9]+:/ { n += $2 } END { printf "%.0f", n }' /proc/net/dev"#,
    )
    .parse()
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn retry_resumes_an_upload_across_a_dropped_connection() {
    let Some(sshd) = support::sshd(Service::Flaky) else {
        return;
    };
    let scratch = tempfile::tempdir().unwrap();
    let (manager, host) = endpoint(&sshd, scratch.path());
    let manager = Arc::new(manager);
    let prompts = Arc::new(Trusting(sshd.password));
    let connection = manager.connect(&host, prompts.clone()).await.unwrap();
    let fs = manager.live_sftp(&host.id).await.unwrap();
    let remote_dir = format!("/home/tester/resume-{}", uuid::Uuid::new_v4());
    fs.create_dir(&remote_dir).await.unwrap();
    let destination = format!("{remote_dir}/large");
    fs.write_file(&destination, b"original upload")
        .await
        .unwrap();
    fs.set_permissions(&destination, 0o600).await.unwrap();

    // Distinct, incompressible blocks make both byte comparison and network
    // byte counts meaningful. Keep the file within read_file's size limit.
    const SIZE: usize = 8 * 1024 * 1024;
    let mut bytes = Vec::with_capacity(SIZE);
    let mut state = 123456789u64;
    for _ in 0..SIZE / 8 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        bytes.extend_from_slice(&state.to_le_bytes());
    }
    let source = scratch.path().join("large");
    std::fs::write(&source, &bytes).unwrap();

    let open: OpenRemote = {
        let manager = manager.clone();
        let id = host.id.clone();
        Arc::new(move || {
            let manager = manager.clone();
            let id = id.clone();
            Box::pin(async move { Ok(manager.live_sftp(&id).await? as Arc<dyn RemoteFs>) })
        })
    };
    let progress = Arc::new(Mutex::new(Vec::new()));
    let events = progress.clone();
    let (first_write, written) = tokio::sync::oneshot::channel();
    let (disconnected, wait_for_drop) = mpsc::channel();
    let interrupt = Mutex::new(Some((first_write, wait_for_drop)));
    let queue = TransferQueue::new(Arc::new(DiskFs), move |t| {
        events.lock().unwrap().push(t.clone());
        if t.state == TransferState::Running && t.bytes_done > 0 {
            if let Some((notify, wait)) = interrupt.lock().unwrap().take() {
                // Freeze the copy while allowing the SSH task to deliver
                // its pipelined writes to the server.
                tokio::task::block_in_place(|| {
                    let _ = notify.send(());
                    let _ = wait.recv_timeout(Duration::from_secs(15));
                });
            }
        }
    });

    let id = queue.upload(open, source, remote_dir.clone());
    wait_until(&queue, |t| {
        matches!(t.state, TransferState::Conflict { .. })
    })
    .await;
    queue.answer(id, ConflictAnswer::Overwrite);
    tokio::time::timeout(Duration::from_secs(10), written)
        .await
        .unwrap()
        .unwrap();
    let interrupted_dir = remote_dir.clone();
    let sshd = tokio::task::spawn_blocking(move || {
        // The progress update covers writes enqueued by russh-sftp. Wait
        // until enough bytes are on disk to distinguish resume on the wire.
        sshd.run_as_tester(&format!(
            r#"for try in $(seq 1 100); do
                size=$(stat -c %s {interrupted_dir}/.sshastra-*.part)
                if [ "$size" -ge 131072 ]; then exit 0; fi
                sleep 0.05
            done
            exit 1"#,
        ));
        sshd.drop_connections();
        let _ = disconnected.send(());
        sshd
    })
    .await
    .unwrap();

    wait_until(&queue, |t| matches!(t.state, TransferState::Failed { .. })).await;
    drop(fs);
    tokio::time::timeout(Duration::from_secs(5), async {
        while manager.live(&host.id).await.is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the dropped Connection is no longer live");
    let reconnected = manager.connect(&host, prompts).await.unwrap();
    assert!(!Arc::ptr_eq(&connection, &reconnected));
    let fs = manager.live_sftp(&host.id).await.unwrap();
    assert_eq!(
        fs.read_file(&destination).await.unwrap(),
        b"original upload"
    );

    let entries = fs.list_dir(&remote_dir).await.unwrap();
    let partial = entries.iter().find(|e| e.name.starts_with('.')).unwrap();
    assert!(
        (65_536..bytes.len() as u64).contains(&partial.size),
        "{partial:?}"
    );
    assert_eq!(partial.permissions, Some(0o600));
    let before = received_bytes(&sshd);
    let events_before = progress.lock().unwrap().len();
    queue.retry(id);
    wait_until(&queue, |t| {
        matches!(t.state, TransferState::Conflict { .. })
    })
    .await;
    queue.answer(id, ConflictAnswer::Overwrite);
    settle(&queue).await;
    let received = received_bytes(&sshd) - before;

    assert!(
        received < bytes.len() as u64,
        "retry sent {received} bytes for a {} byte file",
        bytes.len()
    );
    assert!(progress.lock().unwrap()[events_before..]
        .iter()
        .any(|t| { t.state == TransferState::Running && t.bytes_done == partial.size }));
    assert_eq!(fs.read_file(&destination).await.unwrap(), bytes);
    assert_eq!(fs.list_dir(&remote_dir).await.unwrap().len(), 1);
    assert_eq!(
        fs.stat(&destination).await.unwrap().permissions,
        Some(0o600)
    );
    fs.remove_file(&destination).await.unwrap();
    fs.remove_dir(&remote_dir).await.unwrap();
    drop(reconnected);
}
