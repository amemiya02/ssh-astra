//! TransferQueue between the local disk and a real OpenSSH server in Docker:
//! a nested folder goes up and comes back down unchanged. Skipped when
//! Docker is unavailable.

mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sshastra_core::files::{DiskFs, OpenRemote, RemoteFs, TransferQueue, TransferState};
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

async fn remote(sshd: &Sshd, dir: &Path) -> Arc<dyn RemoteFs> {
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
        forwards: Vec::new(),
    };
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
