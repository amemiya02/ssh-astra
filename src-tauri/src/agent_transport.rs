//! One bounded MCP request per local connection. The stdio proxy can stay open
//! between requests without keeping an app-side socket or worker alive.

mod platform;

use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::Value;
use sshastra_core::agent::{dispatch, rpc_error, OpenTerminal};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::runtime::{Builder, Runtime};
use tokio::sync::oneshot;
use tokio::task::JoinSet;

use crate::error::CommandResult;
use platform::{Endpoint, Listener};

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_CLIENTS: usize = 8;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

type Snapshot = dyn Fn() -> Vec<OpenTerminal> + Send + Sync;

pub struct AgentService {
    snapshot: Arc<Snapshot>,
    server: Mutex<Option<Server>>,
}

impl AgentService {
    pub fn new(snapshot: impl Fn() -> Vec<OpenTerminal> + Send + Sync + 'static) -> Self {
        Self {
            snapshot: Arc::new(snapshot),
            server: Mutex::new(None),
        }
    }

    pub fn enabled(&self) -> bool {
        self.lock().as_ref().is_some_and(|server| server.is_running())
    }

    pub fn apply(
        &self,
        enabled: bool,
        save: impl FnOnce() -> CommandResult<()>,
    ) -> CommandResult<()> {
        let mut server = self.lock();
        if !enabled {
            // Revocation closes all clients even if writing settings fails.
            *server = None;
            return save();
        }
        if server.as_ref().is_some_and(|server| server.is_running()) {
            return save();
        }
        *server = None;
        let pending = Server::start(&Endpoint::current_user()?, Arc::clone(&self.snapshot))?;
        save()?;
        pending.active.store(true, Ordering::Release);
        *server = Some(pending);
        Ok(())
    }

    pub fn stop(&self) {
        *self.lock() = None;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Server>> {
        self.server.lock().unwrap_or_else(|p| p.into_inner())
    }
}

struct Server {
    active: Arc<AtomicBool>,
    stop: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl Server {
    fn start(endpoint: &Endpoint, snapshot: Arc<Snapshot>) -> io::Result<Self> {
        let runtime = runtime()?;
        let listener = {
            let _entered = runtime.enter();
            Listener::bind(endpoint)?
        };
        let (stop, stopped) = oneshot::channel();
        let active = Arc::new(AtomicBool::new(false));
        let active_on_thread = Arc::clone(&active);
        let thread = thread::Builder::new()
            .name("sshastra-agent".into())
            .spawn(move || runtime.block_on(serve(listener, active_on_thread, snapshot, stopped)))?;
        Ok(Self { active, stop: Some(stop), thread: Some(thread) })
    }

    fn is_running(&self) -> bool {
        self.thread.as_ref().is_some_and(|thread| !thread.is_finished())
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        drop(self.stop.take());
        // The actor owns the listener and all connected clients. Wait for
        // their handles and the socket file to be released before returning.
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn runtime() -> io::Result<Runtime> {
    Builder::new_current_thread().enable_io().enable_time().build()
}

async fn serve(
    mut listener: Listener,
    active: Arc<AtomicBool>,
    snapshot: Arc<Snapshot>,
    mut stopped: oneshot::Receiver<()>,
) {
    let mut clients = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = &mut stopped => break,
            _ = clients.join_next(), if !clients.is_empty() => {},
            stream = listener.accept(), if clients.len() < MAX_CLIENTS => {
                let Ok(stream) = stream else {
                    // A failed accept must never spin against a bad handle.
                    tokio::select! {
                        _ = &mut stopped => break,
                        _ = tokio::time::sleep(Duration::from_millis(25)) => {}
                    }
                    continue;
                };
                let (active, snapshot) = (Arc::clone(&active), Arc::clone(&snapshot));
                clients.spawn(async move {
                    let _ = tokio::time::timeout(
                        REQUEST_TIMEOUT,
                        converse(stream, &active, snapshot.as_ref()),
                    ).await;
                });
            }
        }
    }
    clients.shutdown().await;
}

async fn converse(
    mut stream: impl AsyncRead + AsyncWrite + Unpin,
    active: &AtomicBool,
    snapshot: &Snapshot,
) -> io::Result<()> {
    let Some(frame) = read_frame(&mut stream, MAX_REQUEST_BYTES).await? else {
        return Ok(());
    };
    let response = dispatch(&frame, active.load(Ordering::Acquire), snapshot);
    if let Some(response) = response.filter(|_| active.load(Ordering::Acquire)) {
        stream.write_all(&json_line(&response)).await?;
    }
    Ok(())
}

async fn read_frame(reader: impl AsyncRead + Unpin, limit: usize) -> io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    BufReader::new(reader).take((limit + 1) as u64).read_until(b'\n', &mut frame).await?;
    validate_frame(frame, limit)
}

fn validate_frame(frame: Vec<u8>, limit: usize) -> io::Result<Option<Vec<u8>>> {
    if frame.is_empty() {
        return Ok(None);
    }
    if frame.last() != Some(&b'\n') || frame.len() > limit {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid MCP frame"));
    }
    Ok(Some(frame))
}

fn json_line(value: &Value) -> Vec<u8> {
    let mut frame = value.to_string().into_bytes();
    frame.push(b'\n');
    frame
}

async fn forward(endpoint: &Endpoint, frame: &[u8]) -> io::Result<Option<Vec<u8>>> {
    let request = async {
        let mut stream = endpoint.connect().await?;
        stream.write_all(frame).await?;
        read_frame(stream, MAX_RESPONSE_BYTES).await
    };
    tokio::time::timeout(REQUEST_TIMEOUT, request).await?
}

/// Called before starting Tauri. Standard output is reserved for MCP frames.
pub fn run_stdio() -> io::Result<()> {
    let endpoint = Endpoint::current_user()?;
    proxy_stdio(&endpoint, io::stdin().lock(), io::stdout().lock())
}

fn proxy_stdio(endpoint: &Endpoint, mut input: impl BufRead, mut output: impl Write) -> io::Result<()> {
    let runtime = runtime()?;
    loop {
        let mut frame = Vec::new();
        std::io::Read::take(&mut input, (MAX_REQUEST_BYTES + 1) as u64)
            .read_until(b'\n', &mut frame)?;
        let Some(frame) = validate_frame(frame, MAX_REQUEST_BYTES)? else {
            return Ok(());
        };
        let response = runtime.block_on(forward(endpoint, &frame)).ok().flatten().or_else(|| {
            let request: Value = serde_json::from_slice(&frame).ok()?;
            let id = request.get("id")?.clone();
            Some(json_line(&rpc_error(id, -32000, "SSH Astra Agent access is unavailable")))
        });
        if let Some(response) = response {
            output.write_all(&response)?;
            output.flush()?;
        }
    }
}

#[cfg(test)]
mod tests;
