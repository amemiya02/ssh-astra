//! Reads use a saved Host's existing Terminal and exact Connection.
//! Screen requests and action reviews use that Terminal's own renderer.

pub(crate) mod review;

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use serde::Serialize;
use sshastra_core::agent::{
    ActivityCursor, ActivityPage, AgentActivityLog, AgentBackend, ApprovedFileWrite, DirectoryRead,
    OpenTerminal, ReadError, ReadTarget, ReviewOutcome, TerminalScreen, SCREEN_BYTE_LIMIT,
};
use sshastra_core::files::{FsError, FsResult, SftpFs, StagedRemoteWrite};
use sshastra_core::ssh::{BoxFuture, Connection};
use sshastra_core::terminal::{TerminalId, TerminalRegistry};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Manager, State, Webview,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::sync::{oneshot, Semaphore};
use tokio::time::Instant;

use crate::terminal_handoff::TerminalRoute;
use crate::windows;

use super::hosts::HostsState;

use crate::error::CommandResult;
pub(crate) use review::PendingReviews;
use review::{ReviewChoice, ReviewDetails};

const MAX_PENDING_REMOTE_IO: usize = 8;

pub(crate) struct DesktopAgent {
    app: AppHandle,
    hosts: HostsState,
    registry: TerminalRegistry,
    remote_slots: Arc<Semaphore>,
}

impl DesktopAgent {
    pub fn new(app: AppHandle, hosts: HostsState, registry: TerminalRegistry) -> Self {
        Self {
            app,
            hosts,
            registry,
            remote_slots: Arc::new(Semaphore::new(MAX_PENDING_REMOTE_IO)),
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

    fn review_target_current(
        &self,
        target: &ReadTarget,
        route: &Arc<TerminalRoute>,
        enabled: &(dyn Fn() -> bool + Sync),
    ) -> bool {
        enabled()
            && self.target(target.terminal).is_some_and(|current| {
                current.same_authorization(target) && current.host_name == target.host_name
            })
            && windows::terminal_route(&self.app, target.terminal)
                .is_some_and(|current| Arc::ptr_eq(&current, route))
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

    async fn write_approved_file(
        &self,
        connection: Arc<Connection>,
        path: String,
        bytes: Vec<u8>,
        authorized: &(dyn Fn() -> bool + Sync),
    ) -> ReviewOutcome {
        if !authorized() {
            return ReviewOutcome::Unavailable;
        }
        let Ok(permit) = Arc::clone(&self.remote_slots).try_acquire_owned() else {
            return ReviewOutcome::WriteFailed;
        };
        let (keep_staging, mut cancelled) = oneshot::channel::<()>();
        // Wait for an opened SSH channel to be owned and closed even when the
        // caller disconnects mid-open. This task can only stage and clean up.
        let task = tauri::async_runtime::spawn(async move {
            let fs = Arc::new(connection.open_sftp().await?);
            tokio::select! {
                biased;
                _ = &mut cancelled => Ok(None),
                stage = StagedRemoteWrite::prepare(fs, &path, &bytes) => {
                    stage.map(|stage| Some((stage, permit)))
                }
            }
        });
        let prepared = task.await;
        drop(keep_staging);
        let Ok(Ok(Some((stage, _permit)))) = prepared else {
            return ReviewOutcome::WriteFailed;
        };
        // Publication stays with the original MCP call.
        match stage.publish(authorized).await {
            Ok(true) => ReviewOutcome::Written,
            Ok(false) => ReviewOutcome::Unavailable,
            Err(_) => ReviewOutcome::WriteFailed,
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

    fn request_command_review<'a>(
        &'a self,
        target: &'a ReadTarget,
        command: String,
        enabled: &'a (dyn Fn() -> bool + Sync),
        deadline: Instant,
    ) -> BoxFuture<'a, ReviewOutcome> {
        Box::pin(async move {
            let unavailable = ReviewOutcome::Unavailable;
            let Some(mut permission) = self.hosts.watch_agent_approval(&target.host) else {
                return unavailable;
            };
            let Some(route) = windows::terminal_route(&self.app, target.terminal) else {
                return unavailable;
            };
            let current_target = || self.review_target_current(target, &route, enabled);
            let Some((delivery, mut route_changes)) = route.lock().review_delivery() else {
                return unavailable;
            };
            let Some(mut prompt) = self.registry.observe_idle_prompt(target.terminal).await else {
                return unavailable;
            };
            let Some(prompt_id) = *prompt.borrow_and_update() else {
                return unavailable;
            };
            if !current_target()
                || !matches!(permission.has_changed(), Ok(false))
                || !matches!(route_changes.has_changed(), Ok(false))
            {
                return unavailable;
            }
            let details = ReviewDetails::Command {
                terminal_id: target.terminal,
                host: sshastra_core::agent::bound_metadata(target.host_name.clone(), 512),
                prompt_id,
                command: &command,
            };
            let broker = self.app.state::<Arc<PendingReviews>>();
            let Some(mut review) = broker.inner().request(delivery, details) else {
                return unavailable;
            };
            let answer = tokio::select! {
                biased;
                _ = permission.changed() => return unavailable,
                _ = route_changes.changed() => return unavailable,
                _ = prompt.changed() => return unavailable,
                answer = &mut review.answer => match answer {
                    Ok(answer) => answer,
                    Err(_) => return unavailable,
                },
            };
            let outcome = match answer.choice {
                ReviewChoice::Reject => ReviewOutcome::Rejected,
                ReviewChoice::Unavailable | ReviewChoice::Approve => unavailable,
                ReviewChoice::Copy => {
                    // Drain previously queued user input and confirm that the
                    // very same prompt and renderer still own this choice.
                    let observed = self.registry.observe_idle_prompt(target.terminal).await;
                    let idle = observed.as_ref().and_then(|state| *state.borrow());
                    if Instant::now() >= deadline {
                        ReviewOutcome::TimedOut
                    } else if idle != Some(prompt_id)
                        || !matches!(prompt.has_changed(), Ok(false))
                        || !matches!(permission.has_changed(), Ok(false))
                        || !matches!(route_changes.has_changed(), Ok(false))
                        || !current_target()
                    {
                        unavailable
                    } else if self.app.clipboard().write_secret(command).is_ok() {
                        ReviewOutcome::Copied
                    } else {
                        ReviewOutcome::ClipboardUnavailable
                    }
                }
            };
            let _ = answer.completed.send(outcome);
            outcome
        })
    }

    fn request_file_write_approval<'a>(
        &'a self,
        target: &'a ReadTarget,
        path: String,
        byte_length: usize,
        enabled: &'a (dyn Fn() -> bool + Sync),
        deadline: Instant,
    ) -> BoxFuture<'a, Result<ApprovedFileWrite<'a>, ReviewOutcome>> {
        Box::pin(async move {
            let unavailable = ReviewOutcome::Unavailable;
            let mut permission = self
                .hosts
                .watch_agent_approval(&target.host)
                .ok_or(unavailable)?;
            let route = windows::terminal_route(&self.app, target.terminal).ok_or(unavailable)?;
            let connection = self.connection(target).map_err(|_| unavailable)?;
            let (delivery, mut route_changes) =
                route.lock().review_delivery().ok_or(unavailable)?;
            if !self.review_target_current(target, &route, enabled)
                || !matches!(permission.has_changed(), Ok(false))
                || !matches!(route_changes.has_changed(), Ok(false))
            {
                return Err(unavailable);
            }
            let details = ReviewDetails::FileWrite {
                terminal_id: target.terminal,
                host: &target.host_name,
                path: &path,
                byte_length,
            };
            let broker = self.app.state::<Arc<PendingReviews>>();
            let mut review = broker
                .inner()
                .request(delivery, details)
                .ok_or(unavailable)?;
            let answer = tokio::select! {
                biased;
                _ = permission.changed() => return Err(unavailable),
                _ = route_changes.changed() => return Err(unavailable),
                answer = &mut review.answer => answer.map_err(|_| unavailable)?,
            };
            let refusal = match answer.choice {
                ReviewChoice::Reject => Some(ReviewOutcome::Rejected),
                ReviewChoice::Approve if Instant::now() >= deadline => {
                    Some(ReviewOutcome::TimedOut)
                }
                ReviewChoice::Approve => None,
                _ => Some(unavailable),
            };
            if let Some(outcome) = refusal {
                let _ = answer.completed.send(outcome);
                return Err(outcome);
            }
            let write: ApprovedFileWrite<'a> = Box::new(move |bytes, deadline| {
                Box::pin(async move {
                    let _review = review;
                    let mut host_changes = permission.clone();
                    let mut terminal_changes = route_changes.clone();
                    let authorized = || {
                        Instant::now() < deadline
                            && self.review_target_current(target, &route, enabled)
                            && matches!(permission.has_changed(), Ok(false))
                            && matches!(route_changes.has_changed(), Ok(false))
                    };
                    let outcome = tokio::select! {
                        biased;
                        _ = host_changes.changed() => unavailable,
                        _ = terminal_changes.changed() => unavailable,
                        outcome = self.write_approved_file(connection, path, bytes, &authorized) => outcome,
                    };
                    let _ = answer.completed.send(outcome);
                    outcome
                })
            });
            Ok(write)
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
