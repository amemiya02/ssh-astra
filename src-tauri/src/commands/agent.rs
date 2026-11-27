//! The Agent reads the saved Host's existing Terminal and its exact Connection.
//! A screen request uses that Terminal's own webview channel and a one-shot reply.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use serde::Serialize;
use sshastra_core::agent::{
    ActivityCursor, ActivityPage, AgentActivityLog, AgentBackend, DirectoryRead, OpenTerminal,
    ReadError, ReadTarget, TerminalScreen, SCREEN_BYTE_LIMIT,
};
use sshastra_core::files::{FsError, FsResult, SftpFs};
use sshastra_core::ssh::{BoxFuture, Connection};
use sshastra_core::terminal::{TerminalId, TerminalRegistry};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    State, Webview,
};
use tokio::sync::{oneshot, Semaphore};

use super::hosts::HostsState;
use crate::error::CommandResult;

const MAX_PENDING_REMOTE_READS: usize = 8;

pub(crate) struct DesktopAgent {
    hosts: HostsState,
    registry: TerminalRegistry,
    remote_slots: Arc<Semaphore>,
}

impl DesktopAgent {
    pub fn new(hosts: HostsState, registry: TerminalRegistry) -> Self {
        Self {
            hosts,
            registry,
            remote_slots: Arc::new(Semaphore::new(MAX_PENDING_REMOTE_READS)),
        }
    }

    fn connection(&self, target: &ReadTarget) -> Result<Arc<Connection>, ReadError> {
        let (generation, connection) = self
            .registry
            .connection(target.terminal)
            .ok()
            .flatten()
            .ok_or(ReadError::ConnectionUnavailable)?;
        if Some(generation) != target.generation {
            return Err(ReadError::ConnectionUnavailable);
        }
        Ok(connection)
    }

    async fn remote_read<T, F>(
        &self,
        operation: impl FnOnce(oneshot::Receiver<()>) -> F + Send + 'static,
    ) -> Result<T, ReadError>
    where
        T: Send + 'static,
        F: Future<Output = FsResult<Option<T>>> + Send + 'static,
    {
        let permit = Arc::clone(&self.remote_slots)
            .try_acquire_owned()
            .map_err(|_| ReadError::RemoteReadBusy)?;
        let (cancel, cancelled) = oneshot::channel();
        // A canceled channel open waits for the server's channel ID so it can
        // close the remote channel. Keep its slot occupied until cleanup.
        let task = tauri::async_runtime::spawn(async move {
            let _permit = permit;
            operation(cancelled).await
        });
        let result = task.await;
        drop(cancel);
        match result {
            Ok(Ok(Some(data))) => Ok(data),
            Ok(Err(FsError::NotConnected)) => Err(ReadError::ConnectionUnavailable),
            _ => Err(ReadError::PathUnavailable),
        }
    }
}

impl AgentBackend for DesktopAgent {
    fn terminals(&self) -> Vec<OpenTerminal> {
        self.hosts.agent_terminals(&self.registry)
    }

    fn target(&self, id: TerminalId) -> Option<ReadTarget> {
        let terminal = self.registry.saved_terminal(id)?;
        let (permission, host_name) = self
            .hosts
            .with(|store| {
                Ok(store
                    .get(&terminal.host)
                    .map(|host| (host.agent_access, host.name.clone())))
            })
            .ok()
            .flatten()?;
        Some(ReadTarget {
            terminal: id,
            host: terminal.host.clone(),
            host_name,
            permission,
            status: terminal.snapshot().status?,
            generation: self
                .registry
                .connection(id)
                .ok()?
                .map(|(generation, _)| generation),
        })
    }

    fn read_screen(
        &self,
        target: &ReadTarget,
        lines: usize,
    ) -> BoxFuture<'_, Result<TerminalScreen, ReadError>> {
        let request = self
            .registry
            .saved_terminal(target.terminal)
            .and_then(|terminal| terminal.read_screen(lines));
        Box::pin(async move {
            request
                .ok_or(ReadError::ScreenUnavailable)?
                .await
                .ok_or(ReadError::ScreenUnavailable)
        })
    }

    fn list_directory<'a>(
        &'a self,
        target: &'a ReadTarget,
        path: &'a str,
    ) -> BoxFuture<'a, Result<DirectoryRead, ReadError>> {
        Box::pin(async move {
            let connection = self.connection(target)?;
            let path = path.to_owned();
            self.remote_read(move |cancelled| async move {
                SftpFs::agent_list(&connection, &path, cancelled).await
            })
            .await
        })
    }

    fn read_file<'a>(
        &'a self,
        target: &'a ReadTarget,
        path: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u8>, ReadError>> {
        Box::pin(async move {
            let connection = self.connection(target)?;
            let path = path.to_owned();
            self.remote_read(move |cancelled| async move {
                SftpFs::agent_read(&connection, &path, cancelled).await
            })
            .await
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenMessage {
    agent_screen: ScreenRequest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenRequest {
    request_id: u64,
    scrollback_lines: usize,
}

struct PendingScreen {
    webview: String,
    reply: oneshot::Sender<TerminalScreen>,
}

#[derive(Default)]
pub(crate) struct PendingScreens {
    next: AtomicU64,
    requests: Mutex<HashMap<u64, PendingScreen>>,
}

struct ScreenWait {
    pending: Arc<PendingScreens>,
    id: u64,
}

impl Drop for ScreenWait {
    fn drop(&mut self) {
        self.pending.lock().remove(&self.id);
    }
}

impl PendingScreens {
    pub(super) fn request(
        self: &Arc<Self>,
        webview: &str,
        channel: &Channel<InvokeResponseBody>,
        scrollback_lines: usize,
    ) -> BoxFuture<'static, Option<TerminalScreen>> {
        let (reply, receive) = oneshot::channel();
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.lock().insert(
            id,
            PendingScreen {
                webview: webview.into(),
                reply,
            },
        );
        let wait = ScreenWait {
            pending: self.clone(),
            id,
        };
        let message = ScreenMessage {
            agent_screen: ScreenRequest {
                request_id: id,
                scrollback_lines,
            },
        };
        let sent = serde_json::to_string(&message)
            .ok()
            .is_some_and(|json| channel.send(InvokeResponseBody::Json(json)).is_ok());
        Box::pin(async move {
            let _wait = wait;
            if sent {
                receive.await.ok()
            } else {
                None
            }
        })
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<u64, PendingScreen>> {
        self.requests.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn answer(&self, webview: &str, id: u64, snapshot: TerminalScreen) {
        let mut requests = self.lock();
        if requests
            .get(&id)
            .is_some_and(|pending| pending.webview == webview)
        {
            if let Some(pending) = requests.remove(&id) {
                if snapshot
                    .screen
                    .len()
                    .saturating_add(snapshot.scrollback.len())
                    <= SCREEN_BYTE_LIMIT
                {
                    let _ = pending.reply.send(snapshot);
                }
            }
        }
    }
}

#[tauri::command]
pub(crate) fn terminal_agent_screen(
    webview: Webview,
    pending: State<'_, Arc<PendingScreens>>,
    request_id: u64,
    snapshot: TerminalScreen,
) {
    pending.answer(webview.label(), request_id, snapshot);
}

#[tauri::command]
pub(crate) async fn agent_activity_list(
    activity: State<'_, Arc<AgentActivityLog>>,
    before: Option<ActivityCursor>,
) -> CommandResult<ActivityPage> {
    Ok(activity.list(SystemTime::now(), before)?)
}

#[tauri::command]
pub(crate) async fn agent_activity_clear(
    activity: State<'_, Arc<AgentActivityLog>>,
) -> CommandResult<()> {
    Ok(activity.clear()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn agent_screen_replies_are_scoped_to_the_originating_webview() {
        let pending = Arc::new(PendingScreens::default());
        let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
        let channel = Channel::new(move |body| {
            send.send(body).unwrap();
            Ok(())
        });
        let request = tokio::spawn(pending.request("origin", &channel, 6));
        let InvokeResponseBody::Json(message) = receive.recv().await.unwrap() else {
            panic!("screen request must be JSON");
        };
        let message: serde_json::Value = serde_json::from_str(&message).unwrap();
        let id = message["agentScreen"]["requestId"].as_u64().unwrap();
        assert_eq!(message["agentScreen"]["scrollbackLines"], 6);
        let screen = |text: &str| TerminalScreen {
            screen: text.into(),
            scrollback: String::new(),
            truncated: false,
        };
        pending.answer("another", id, screen("other webview"));
        pending.answer("origin", id, screen("origin webview"));
        assert_eq!(request.await.unwrap().unwrap().screen, "origin webview");
    }
}
