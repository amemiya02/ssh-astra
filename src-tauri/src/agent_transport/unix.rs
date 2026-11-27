use std::fs::{self, DirBuilder, File};
use std::io;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use rustix::fs::{flock, open, FlockOperation, Mode, OFlags};
use rustix::process::geteuid;
use tokio::net::{UnixListener, UnixStream};

#[derive(Clone)]
pub struct Endpoint(PathBuf);

impl Endpoint {
    pub fn current_user() -> io::Result<Self> {
        // Shared with the CLI even when an app launcher and the client have
        // different TMPDIRs. Keep within the Unix-domain pathname limit.
        Ok(Self(PathBuf::from(format!(
            "/tmp/sshastra-{}",
            geteuid().as_raw()
        ))))
    }

    #[cfg(test)]
    pub fn isolated(directory: &Path) -> Self {
        Self(directory.join("agent"))
    }

    pub fn socket(&self) -> PathBuf {
        self.0.join("agent.sock")
    }

    pub async fn connect(&self) -> io::Result<UnixStream> {
        verify_directory(&self.0)?;
        let path = self.socket();
        let socket = fs::symlink_metadata(&path)?;
        if !socket.file_type().is_socket() || !owned_and_private(&socket) {
            return Err(permission_denied());
        }
        let stream = UnixStream::connect(path).await?;
        verify_peer(&stream)?;
        Ok(stream)
    }
}

fn owned_and_private(metadata: &fs::Metadata) -> bool {
    metadata.uid() == geteuid().as_raw() && metadata.mode() & 0o077 == 0
}

fn verify_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || !owned_and_private(&metadata) {
        return Err(permission_denied());
    }
    Ok(())
}

fn verify_peer(stream: &UnixStream) -> io::Result<()> {
    if stream.peer_cred()?.uid() != geteuid().as_raw() {
        return Err(permission_denied());
    }
    Ok(())
}

fn permission_denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Agent access endpoint is not private",
    )
}

pub struct Listener {
    listener: UnixListener,
    _socket: SocketFile,
    _lock: File,
}

struct SocketFile(PathBuf);

impl Drop for SocketFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

impl Listener {
    pub fn bind(endpoint: &Endpoint) -> io::Result<Self> {
        match DirBuilder::new().mode(0o700).create(&endpoint.0) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        verify_directory(&endpoint.0)?;
        let lock = File::from(open(
            endpoint.0.join("agent.lock"),
            OFlags::RDWR | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::RUSR | Mode::WUSR,
        )?);
        let lock_info = lock.metadata()?;
        if !lock_info.is_file() || !owned_and_private(&lock_info) {
            return Err(permission_denied());
        }
        flock(&lock, FlockOperation::NonBlockingLockExclusive)?;

        let path = endpoint.socket();
        match fs::symlink_metadata(&path) {
            Ok(metadata)
                if metadata.file_type().is_socket() && metadata.uid() == geteuid().as_raw() =>
            {
                fs::remove_file(&path)?;
            }
            Ok(_) => return Err(permission_denied()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let listener = UnixListener::bind(&path)?;
        let socket = SocketFile(path);
        fs::set_permissions(&socket.0, fs::Permissions::from_mode(0o600))?;
        Ok(Self {
            listener,
            _socket: socket,
            _lock: lock,
        })
    }

    pub async fn accept(&mut self) -> io::Result<UnixStream> {
        let (stream, _) = self.listener.accept().await?;
        verify_peer(&stream)?;
        Ok(stream)
    }
}
