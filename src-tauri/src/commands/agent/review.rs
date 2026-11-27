//! One pending user decision per Window. The original renderer is notified
//! when a request ends, even when its Terminal has since moved elsewhere.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sshastra_core::{agent::ReviewOutcome, terminal::TerminalId};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{State, Webview};
use tokio::sync::oneshot;

use crate::error::CommandResult;
use crate::terminal_handoff::TerminalDelivery;

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum ReviewDetails<'a> {
    Command {
        terminal_id: TerminalId,
        host: String,
        prompt_id: u64,
        command: &'a str,
    },
}

#[derive(Serialize)]
struct ReviewRequest<'a> {
    id: u64,
    #[serde(flatten)]
    details: ReviewDetails<'a>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReviewChoice {
    Copy,
    Reject,
    Unavailable,
}

pub(super) struct ReviewAnswer {
    pub(super) choice: ReviewChoice,
    pub(super) completed: oneshot::Sender<ReviewOutcome>,
}

struct PendingReview {
    id: u64,
    answer: Option<oneshot::Sender<ReviewAnswer>>,
}

#[derive(Default)]
pub(crate) struct PendingReviews {
    next: AtomicU64,
    windows: Mutex<HashMap<String, PendingReview>>,
}

pub(super) struct ReviewWait {
    broker: Arc<PendingReviews>,
    webview: String,
    events: Channel<InvokeResponseBody>,
    id: u64,
    pub(super) answer: oneshot::Receiver<ReviewAnswer>,
}

impl Drop for ReviewWait {
    fn drop(&mut self) {
        let mut windows = self.broker.lock();
        if windows
            .get(&self.webview)
            .is_some_and(|pending| pending.id == self.id)
        {
            windows.remove(&self.webview);
        }
        // Keep the dismiss ordered before a replacement proposal to this Window.
        let _ = send(&self.events, json!({"agentReviewClosed":self.id}));
    }
}

impl PendingReviews {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, PendingReview>> {
        self.windows.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(super) fn request(
        self: &Arc<Self>,
        delivery: TerminalDelivery,
        details: ReviewDetails<'_>,
    ) -> Option<ReviewWait> {
        let mut windows = self.lock();
        if windows.contains_key(&delivery.webview) {
            return None;
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let message = json!({"agentReview":ReviewRequest { id, details }});
        send(&delivery.events, message).ok()?;
        let (answer, receive) = oneshot::channel();
        windows.insert(
            delivery.webview.clone(),
            PendingReview {
                id,
                answer: Some(answer),
            },
        );
        Some(ReviewWait {
            broker: self.clone(),
            webview: delivery.webview,
            events: delivery.events,
            id,
            answer: receive,
        })
    }

    fn decide(
        &self,
        webview: &str,
        id: u64,
        choice: ReviewChoice,
    ) -> Option<oneshot::Receiver<ReviewOutcome>> {
        let mut windows = self.lock();
        let pending = windows
            .get_mut(webview)
            .filter(|pending| pending.id == id)?;
        // Keep the slot reserved through final validation, while consuming the
        // sender so a duplicate decision cannot win.
        let answer = pending.answer.take()?;
        let (completed, response) = oneshot::channel();
        answer.send(ReviewAnswer { choice, completed }).ok()?;
        Some(response)
    }
}

fn send(channel: &Channel<InvokeResponseBody>, message: Value) -> tauri::Result<()> {
    channel.send(InvokeResponseBody::Json(message.to_string()))
}

#[tauri::command]
pub(crate) async fn terminal_agent_review_answer(
    webview: Webview,
    pending: State<'_, Arc<PendingReviews>>,
    id: u64,
    choice: ReviewChoice,
) -> CommandResult<ReviewOutcome> {
    let Some(response) = pending.decide(webview.label(), id, choice) else {
        return Ok(ReviewOutcome::Unavailable);
    };
    Ok(response.await.unwrap_or(ReviewOutcome::Unavailable))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn one_decision_is_scoped_to_its_original_window_and_request() {
        let broker = Arc::new(PendingReviews::default());
        let (messages, mut events) = mpsc::unbounded_channel();
        let delivery = TerminalDelivery {
            webview: "origin".into(),
            events: Channel::new(move |event| {
                messages.send(event).unwrap();
                Ok(())
            }),
            prompts: None,
        };
        let details = |command| ReviewDetails::Command {
            terminal_id: 7.into(),
            host: "Work".into(),
            prompt_id: 1,
            command,
        };
        let mut review = broker.request(delivery.clone(), details("pwd")).unwrap();
        let InvokeResponseBody::Json(message) = events.recv().await.unwrap() else {
            panic!("expected a proposal");
        };
        let message: Value = serde_json::from_str(&message).unwrap();
        let id = message["agentReview"]["id"].as_u64().unwrap();
        assert_eq!(message["agentReview"]["command"], "pwd");
        assert!(broker
            .request(delivery.clone(), details("whoami"))
            .is_none());
        assert!(broker.decide("other", id, ReviewChoice::Copy).is_none());
        assert!(broker
            .decide("origin", id + 1, ReviewChoice::Copy)
            .is_none());
        let reply = broker.decide("origin", id, ReviewChoice::Reject).unwrap();
        assert!(broker.decide("origin", id, ReviewChoice::Copy).is_none());
        let answer = (&mut review.answer).await.unwrap();
        assert!(matches!(answer.choice, ReviewChoice::Reject));
        let _ = answer.completed.send(ReviewOutcome::Rejected);
        drop(review);
        assert_eq!(reply.await.unwrap(), ReviewOutcome::Rejected);
        let InvokeResponseBody::Json(message) = events.recv().await.unwrap() else {
            panic!("expected a dismissal");
        };
        assert_eq!(
            serde_json::from_str::<Value>(&message).unwrap(),
            json!({"agentReviewClosed":id})
        );
        let next = broker.request(delivery, details("pwd")).unwrap();
        assert!(broker.decide("origin", id, ReviewChoice::Copy).is_none());
        drop(next);
    }
}
