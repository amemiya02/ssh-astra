//! Standalone timed runs against the loopback OpenSSH benchmark fixtures.
//! See docs/baseline.md for the Compose setup and command lines.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use sshastra_core::files::{DiskFs, FileKind, OpenRemote, RemoteFs, TransferQueue, TransferState};
use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::{HostKey, KnownHosts};
use sshastra_core::ssh::{
    BoxFuture, ConnectionManager, HostKeyDecision, HostKeyPrompt, PasswordPrompt, Prompter, Secret,
};
use tokio::sync::mpsc;

const LARGE_BYTES: usize = 32 * 1024 * 1024;
const SMALL_BYTES: usize = 1024;
const SMALL_FILES: usize = 1000;

struct FixtureLogin(String);

impl Prompter for FixtureLogin {
    fn confirm_host_key(&self, prompt: HostKeyPrompt) -> BoxFuture<'_, HostKeyDecision> {
        Box::pin(async move {
            if prompt.fingerprint == self.0 {
                HostKeyDecision::SaveAndTrust
            } else {
                HostKeyDecision::Reject
            }
        })
    }

    fn password(&self, _: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        Box::pin(async { Some(Secret::new("testpass")) })
    }
}

async fn connect(port: &str, scratch: &Path) -> Arc<dyn RemoteFs> {
    let key =
        HostKey::from_openssh(include_str!("../tests/sshd/ssh_host_ed25519_key.pub")).unwrap();
    let manager = ConnectionManager::new(KnownHosts::new(scratch.join("known_hosts")));
    let host = Host {
        id: HostId::from(port.to_owned()),
        name: "Performance fixture".into(),
        tags: Vec::new(),
        icon: None,
        detected_os: None,
        color: None,
        address: "127.0.0.1".into(),
        port: port.parse().expect("a loopback fixture port"),
        user: "tester".into(),
        auth: HostAuth::Password,
        jump_host: None,
        group_id: None,
        terminal_scheme: None,
        identities_only: false,
        forward_agent: false,
        allow_legacy_algorithms: false,
        open_on_startup: false,
        proxy: Default::default(),
        keepalive_seconds: None,
        post_login_command: None,
        terminal_charset: None,
        terminal_backspace: None,
        default_directory: None,
        forwards: Vec::new(),
        bookmarks: Vec::new(),
    };
    let connection = manager
        .connect(&host, Arc::new(FixtureLogin(key.fingerprint())))
        .await
        .expect("connect to the Compose OpenSSH fixture");
    Arc::new(connection.open_sftp().await.expect("open SFTP"))
}

fn median(mut times: [f64; 5]) -> f64 {
    times.sort_by(f64::total_cmp);
    times[2]
}

async fn listings(remote: &dyn RemoteFs, link: &str) {
    let mut stat_ms = [0.0; 5];
    for ms in &mut stat_ms {
        let start = Instant::now();
        remote.stat("/srv/files/hello.txt").await.unwrap();
        *ms = start.elapsed().as_secs_f64() * 1000.0;
    }
    println!(
        "{}",
        json!({"sftp_stat": link, "median_ms": median(stat_ms), "samples_ms": stat_ms})
    );

    for (name, path, count) in [
        ("many", "/srv/files/many", 10_000),
        ("regular", "/srv/performance/regular", 1000),
        ("links", "/srv/performance/links", 1000),
    ] {
        let mut samples_ms = [0.0; 5];
        for ms in &mut samples_ms {
            let start = Instant::now();
            let entries = remote.list_dir(path).await.unwrap();
            *ms = start.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(entries.len(), count, "fixture {name}");
            if name == "links" {
                assert!(entries
                    .iter()
                    .all(|entry| entry.link_target == Some(FileKind::File)));
            }
        }
        println!(
            "{}",
            json!({"listing": name, "link": link, "entries": count, "median_ms": median(samples_ms), "samples_ms": samples_ms})
        );
    }
}

fn fixture(path: &Path) {
    let mut state = 0xB1A5_7126u32;
    let bytes: Vec<u8> = (0..LARGE_BYTES)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as u8
        })
        .collect();
    std::fs::write(path.join("large.bin"), bytes).unwrap();
    std::fs::create_dir(path.join("small")).unwrap();
    for i in 0..SMALL_FILES {
        std::fs::write(
            path.join(format!("small/{i:04}.bin")),
            [i as u8; SMALL_BYTES],
        )
        .unwrap();
    }
}

async fn transfers(remote: Arc<dyn RemoteFs>, link: &str, scratch: &Path) {
    let source = scratch.join("source");
    let target = scratch.join(link);
    std::fs::create_dir(&target).unwrap();
    let directory = format!("/home/tester/benchmark-{}", uuid::Uuid::new_v4());
    remote.create_dir(&directory).await.unwrap();
    let open: OpenRemote = Arc::new(move || {
        let remote = Arc::clone(&remote);
        Box::pin(async move { Ok(remote) })
    });
    let (sent, mut finished) = mpsc::unbounded_channel();
    let queue = TransferQueue::new(Arc::new(DiskFs), move |transfer| {
        if !matches!(
            transfer.state,
            TransferState::Queued | TransferState::Running
        ) {
            let _ = sent.send((transfer.clone(), Instant::now()));
        }
    });

    for (name, files, bytes) in [
        ("large.bin", 1, LARGE_BYTES),
        ("small", SMALL_FILES, SMALL_BYTES * SMALL_FILES),
    ] {
        for direction in ["upload", "download"] {
            eprintln!("Measuring {link} {direction} {name} …");
            let start = Instant::now();
            let id = if direction == "upload" {
                queue.upload(open.clone(), source.join(name), directory.clone())
            } else {
                queue.download(open.clone(), format!("{directory}/{name}"), target.clone())
            };
            let (transfer, completed) =
                tokio::time::timeout(Duration::from_secs(1800), finished.recv())
                    .await
                    .expect("transfer finished within 30 minutes")
                    .unwrap();
            assert_eq!(transfer.id, id);
            assert_eq!(transfer.state, TransferState::Done);
            assert_eq!(transfer.files_done, files as u64);
            assert_eq!(transfer.bytes_done, bytes as u64);
            let seconds = completed.duration_since(start).as_secs_f64();
            println!(
                "{}",
                json!({"transfer": name, "link": link, "direction": direction, "files": files, "bytes": bytes, "seconds": seconds, "mib_per_second": bytes as f64 / 1048576.0 / seconds})
            );
        }
    }

    for file in std::iter::once("large.bin".to_owned())
        .chain((0..SMALL_FILES).map(|i| format!("small/{i:04}.bin")))
    {
        assert_eq!(
            std::fs::read(source.join(&file)).unwrap(),
            std::fs::read(target.join(&file)).unwrap(),
            "round trip of {file}"
        );
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let [phase, plain_port, delayed_port] = args.as_slice() else {
        panic!("usage: performance <all|list|transfer> <plain port> <delayed port>");
    };
    assert!(matches!(phase.as_str(), "all" | "list" | "transfer"));
    let scratch = tempfile::tempdir().unwrap();
    let plain = connect(plain_port, scratch.path()).await;
    let delayed = connect(delayed_port, scratch.path()).await;
    if phase != "transfer" {
        listings(&*plain, "plain").await;
        listings(&*delayed, "100ms").await;
    }
    if phase != "list" {
        let source = scratch.path().join("source");
        std::fs::create_dir(&source).unwrap();
        fixture(&source);
        transfers(plain, "plain", scratch.path()).await;
        transfers(delayed, "100ms", scratch.path()).await;
    }
}
