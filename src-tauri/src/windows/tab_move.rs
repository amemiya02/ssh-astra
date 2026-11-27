use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use sshastra_core::hosts::HostId;
use sshastra_core::terminal::TerminalId;
use tauri::ipc::{Channel, InvokeResponseBody, JavaScriptChannelId};
use tauri::{AppHandle, Manager, Webview, WebviewWindow};
use tokio::sync::watch;

use super::{build, forget, prompts, remember, reserve_label, Presentation, Windows};
use crate::prompts::PromptEndpoint;
use crate::terminal_handoff::{MoveResult, TerminalDelivery, TerminalRoute};

const MOVE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_PANES: usize = 8;
const MAX_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;
const MOVE_FAILED: &str = "The tab could not move to a new Window";

pub(super) struct TabMove {
    source: String,
    target: String,
    next_id: u64,
    terminals: HashMap<TerminalId, Arc<TerminalRoute>>,
    temporary_hosts: HashSet<HostId>,
    payload: Option<Value>,
    staged: HashMap<TerminalId, TerminalDelivery>,
    result: MoveResult,
}

impl TabMove {
    fn rollback(self, token: &str) {
        self.result.send_replace(Some(false));
        for route in self.terminals.values() {
            route.lock().rollback(token);
        }
    }
}

#[tauri::command]
pub(crate) fn window_prepare_tab_move(
    window: WebviewWindow,
    token: String,
    terminals: HashSet<TerminalId>,
    temporary_hosts: HashSet<HostId>,
) -> Result<(), String> {
    if token.len() > 64 || terminals.len() > MAX_PANES || temporary_hosts.len() > MAX_PANES {
        return Err(MOVE_FAILED.into());
    }
    let windows = window.state::<Windows>();
    let mut moves = windows.moves.lock().unwrap();
    if moves.contains_key(&token)
        || moves
            .values()
            .any(|pending| pending.source == window.label())
    {
        return Err(MOVE_FAILED.into());
    }
    let resources = windows.resources.lock().unwrap();
    let source = resources.get(window.label()).ok_or(MOVE_FAILED)?;
    if !temporary_hosts.is_subset(&source.temporary_hosts) {
        return Err(MOVE_FAILED.into());
    }
    let terminals = terminals
        .into_iter()
        .map(|id| Some((id, source.terminals.get(&id)?.clone())))
        .collect::<Option<HashMap<_, _>>>()
        .ok_or(MOVE_FAILED)?;
    let (target, next_id) = reserve_label(&windows)?;
    let (result, _) = watch::channel(None);
    let pending = TabMove {
        source: window.label().into(),
        target,
        next_id,
        terminals,
        temporary_hosts,
        payload: None,
        staged: HashMap::new(),
        result,
    };
    if pending
        .terminals
        .values()
        .any(|route| !route.lock().prepare(&token, &pending.result))
    {
        pending.rollback(&token);
        return Err(MOVE_FAILED.into());
    }
    moves.insert(token, pending);
    Ok(())
}

#[tauri::command]
pub(crate) async fn window_open_tab_move(
    window: WebviewWindow,
    token: String,
    payload: Value,
) -> Result<(), String> {
    if payload.to_string().len() > MAX_PAYLOAD_BYTES {
        return Err(MOVE_FAILED.into());
    }
    let app = window.app_handle();
    let windows = app.state::<Windows>();
    let (label, next_id, mut result) = {
        let mut moves = windows.moves.lock().unwrap();
        let pending = moves
            .get_mut(&token)
            .filter(|pending| {
                pending.source == window.label()
                    && pending.payload.is_none()
                    && pending.result.borrow().is_none()
            })
            .ok_or(MOVE_FAILED)?;
        pending.payload = Some(payload);
        (
            pending.target.clone(),
            pending.next_id,
            pending.result.subscribe(),
        )
    };

    remember(app, &label, next_id);
    if let Err(error) = build(app, &label, Presentation::Focused) {
        cancel(app, &token, window.label());
        forget(app, &label);
        return Err(error.to_string());
    }

    let committed = tokio::time::timeout(MOVE_TIMEOUT, result.wait_for(Option::is_some))
        .await
        .is_ok_and(|result| result.is_ok_and(|result| *result == Some(true)));
    if committed {
        return Ok(());
    }
    // If commit just won the race with the timeout, it has removed the request.
    if let Some(pending) = take_source_move(app, &token, window.label()) {
        pending.rollback(&token);
    } else if *result.borrow() == Some(true) {
        return Ok(());
    }
    if let Some(target) = app.get_webview_window(&label) {
        let _ = target.destroy();
    }
    forget(app, &label);
    Err(MOVE_FAILED.into())
}

#[tauri::command]
pub(crate) fn window_incoming_tab_move(window: WebviewWindow) -> Option<Value> {
    let windows = window.state::<Windows>();
    let moves = windows.moves.lock().unwrap();
    let pending = moves
        .values()
        .find(|pending| pending.target == window.label())?;
    pending.payload.clone()
}

#[tauri::command]
pub(crate) fn window_stage_moved_terminal(
    window: WebviewWindow,
    webview: Webview,
    id: TerminalId,
    events: Channel<InvokeResponseBody>,
    on_prompt: Option<JavaScriptChannelId>,
) -> Result<(), String> {
    let endpoint = match on_prompt {
        Some(channel) => Some(PromptEndpoint {
            pending: prompts(&window).map_err(|_| MOVE_FAILED)?,
            channel: channel.channel_on(webview.clone()),
        }),
        None => None,
    };
    let windows = window.state::<Windows>();
    let mut moves = windows.moves.lock().unwrap();
    let pending = moves
        .values_mut()
        .find(|pending| pending.target == window.label())
        .filter(|pending| pending.result.borrow().is_none() && pending.terminals.contains_key(&id))
        .ok_or(MOVE_FAILED)?;
    pending.staged.insert(
        id,
        TerminalDelivery {
            webview: webview.label().into(),
            events,
            prompts: endpoint,
        },
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn window_complete_tab_move(window: WebviewWindow) -> Result<(), String> {
    let windows = window.state::<Windows>();
    let mut moves = windows.moves.lock().unwrap();
    let (token, pending) = moves
        .iter()
        .find(|(_, pending)| pending.target == window.label())
        .ok_or(MOVE_FAILED)?;
    if pending.result.borrow().is_some() || pending.staged.len() != pending.terminals.len() {
        return Err(MOVE_FAILED.into());
    }

    let mut resources = windows.resources.lock().unwrap();
    let source = resources.get(&pending.source).ok_or(MOVE_FAILED)?;
    if !resources.contains_key(&pending.target)
        || !pending.temporary_hosts.is_subset(&source.temporary_hosts)
        || !pending
            .terminals
            .keys()
            .all(|id| source.terminals.contains_key(id))
    {
        return Err(MOVE_FAILED.into());
    }
    // Lock all participating routes until the Window ownership has changed and
    // all output has been redirected. A reconnect, exit, or overflow can only
    // run before or after this commit.
    let mut routes: Vec<_> = pending
        .terminals
        .iter()
        .map(|(id, route)| (id, route.lock()))
        .collect();
    if pending.result.borrow().is_some() || routes.iter().any(|(_, route)| !route.prepared(token)) {
        return Err(MOVE_FAILED.into());
    }
    let source = resources
        .get_mut(&pending.source)
        .expect("source was checked");
    let terminals: Vec<_> = pending
        .terminals
        .keys()
        .map(|id| {
            (
                *id,
                source.terminals.remove(id).expect("ownership was checked"),
            )
        })
        .collect();
    let target = resources
        .get_mut(&pending.target)
        .expect("target was checked");
    target.terminals.extend(terminals);
    // A split or duplicate can use the same Temporary Host in both Windows.
    target
        .temporary_hosts
        .extend(pending.temporary_hosts.iter().cloned());
    for (id, route) in &mut routes {
        route.adopt(pending.staged[*id].clone());
    }
    pending.result.send_replace(Some(true));
    drop(routes);
    let token = token.clone();
    moves.remove(&token);
    Ok(())
}

fn take_source_move(app: &AppHandle, token: &str, source: &str) -> Option<TabMove> {
    let windows = app.state::<Windows>();
    let mut moves = windows.moves.lock().unwrap();
    if moves
        .get(token)
        .is_some_and(|pending| pending.source == source)
    {
        moves.remove(token)
    } else {
        None
    }
}

fn cancel(app: &AppHandle, token: &str, source: &str) {
    if let Some(pending) = take_source_move(app, token, source) {
        pending.rollback(token);
    }
}

#[tauri::command]
pub(crate) fn window_cancel_tab_move(window: WebviewWindow, token: String) {
    cancel(window.app_handle(), &token, window.label());
}

pub(super) fn window_destroyed(windows: &Windows, label: &str) {
    let mut moves = windows.moves.lock().unwrap();
    moves.retain(|token, pending| {
        if pending.source == label || pending.target == label {
            pending.result.send_replace(Some(false));
            for route in pending.terminals.values() {
                route.lock().rollback(token);
            }
            return pending.payload.is_some(); // The opener destroys the target and forgets the layout.
        }
        true
    });
}
