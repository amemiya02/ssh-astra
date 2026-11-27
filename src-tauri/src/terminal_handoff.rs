//! Routes a live Terminal to one renderer and fences its output during a tab move.

use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::json;
use sshastra_core::monitor::ResourceInterval;
use sshastra_core::terminal::{ConnectionState, TerminalEvent};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::{oneshot, watch, Mutex as AsyncMutex};

use crate::prompts::{PromptEndpoint, PromptRequest};

const MAX_PENDING_BYTES: usize = 1024 * 1024;
const MAX_PENDING_MESSAGES: usize = 4096;

pub(crate) type MoveResult = watch::Sender<Option<bool>>;

#[derive(Clone)]
pub(crate) struct TerminalDelivery {
    pub(crate) webview: String,
    pub(crate) events: Channel<InvokeResponseBody>,
    pub(crate) prompts: Option<PromptEndpoint>,
}

pub(crate) struct TerminalRoute(Mutex<Route>);

pub(crate) struct Route {
    pub(crate) delivery: TerminalDelivery,
    pending: Option<PendingOutput>,
    running: bool,
    resource_subscription: Option<ActiveResources>,
    resource_channel: Arc<AsyncMutex<()>>,
    review_changes: watch::Sender<()>,
}

pub(crate) struct ResourceSubscription {
    pub(crate) stopped: oneshot::Receiver<()>,
    pub(crate) channel: Arc<AsyncMutex<()>>,
    pub(crate) interval: watch::Receiver<ResourceInterval>,
}

struct ActiveResources {
    id: u32,
    _stop: oneshot::Sender<()>,
    interval: watch::Sender<ResourceInterval>,
}

struct PendingOutput {
    token: String,
    result: MoveResult,
    messages: Vec<InvokeResponseBody>,
    bytes: usize,
}

impl TerminalRoute {
    pub(crate) fn new(delivery: TerminalDelivery) -> Arc<Self> {
        Arc::new(Self(Mutex::new(Route {
            delivery,
            pending: None,
            running: true,
            resource_subscription: None,
            resource_channel: Arc::default(),
            review_changes: watch::Sender::new(()),
        })))
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, Route> {
        self.0.lock().unwrap()
    }

    pub(crate) fn send(&self, message: InvokeResponseBody) {
        self.lock().send(message);
    }

    pub(crate) fn connection_event(&self, event: &TerminalEvent) {
        let mut route = self.lock();
        match event {
            TerminalEvent::Connection(state) => {
                route.running = matches!(state, ConnectionState::Connected);
                // Authentication prompts are bound to their originating Window. Leave a
                // reconnect that starts during the move entirely with the source.
                if !route.running {
                    route.stop_resources();
                    route.invalidate_reviews();
                    route.abort();
                }
                if let Some(prompts) = &route.delivery.prompts {
                    let _ = prompts.channel.send(PromptRequest::Reconnect {
                        state: state.clone(),
                    });
                }
            }
            TerminalEvent::Exit { .. } => {
                route.running = false;
                route.stop_resources();
                route.invalidate_reviews();
                route.abort();
            }
            _ => {}
        }
    }
}

impl Route {
    pub(crate) fn start_resources(
        &mut self,
        subscription: u32,
        interval: ResourceInterval,
    ) -> Option<ResourceSubscription> {
        if !self.running || self.pending.is_some() {
            return None;
        }
        let (stop, stopped) = oneshot::channel();
        let (update, interval) = watch::channel(interval);
        self.resource_subscription = Some(ActiveResources {
            id: subscription,
            _stop: stop,
            interval: update,
        });
        Some(ResourceSubscription {
            stopped,
            channel: Arc::clone(&self.resource_channel),
            interval,
        })
    }

    pub(crate) fn set_resource_interval(&self, subscription: u32, interval: ResourceInterval) {
        if let Some(active) = self
            .resource_subscription
            .as_ref()
            .filter(|active| active.id == subscription)
        {
            let _ = active.interval.send(interval);
        }
    }

    pub(crate) fn stop_resource_subscription(&mut self, subscription: u32) {
        if self
            .resource_subscription
            .as_ref()
            .is_some_and(|active| active.id == subscription)
        {
            self.stop_resources();
        }
    }

    pub(crate) fn stop_resources(&mut self) {
        self.resource_subscription = None;
    }

    pub(crate) fn review_delivery(&self) -> Option<(TerminalDelivery, watch::Receiver<()>)> {
        (self.running && self.pending.is_none())
            .then(|| (self.delivery.clone(), self.review_changes.subscribe()))
    }

    pub(crate) fn invalidate_reviews(&self) {
        self.review_changes.send_replace(());
    }

    pub(crate) fn prepare(&mut self, token: &str, result: &MoveResult) -> bool {
        if !self.running || self.pending.is_some() {
            return false;
        }
        self.invalidate_reviews();
        let fence = json!({ "moveFence": token }).to_string();
        if self
            .delivery
            .events
            .send(InvokeResponseBody::Json(fence))
            .is_err()
        {
            return false;
        }
        self.stop_resources();
        self.pending = Some(PendingOutput {
            token: token.into(),
            result: result.clone(),
            messages: Vec::new(),
            bytes: 0,
        });
        true
    }

    pub(crate) fn prepared(&self, token: &str) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|pending| pending.token == token)
    }

    pub(crate) fn adopt(&mut self, delivery: TerminalDelivery) {
        self.delivery = delivery;
        self.flush();
    }

    pub(crate) fn rollback(&mut self, token: &str) {
        if self.prepared(token) {
            self.flush();
        }
    }

    fn send(&mut self, message: InvokeResponseBody) {
        if let Some(pending) = &mut self.pending {
            let bytes = match &message {
                InvokeResponseBody::Raw(data) => data.len(),
                InvokeResponseBody::Json(json) => json.len(),
            };
            pending.bytes = pending.bytes.saturating_add(bytes);
            if pending.bytes <= MAX_PENDING_BYTES && pending.messages.len() < MAX_PENDING_MESSAGES {
                pending.messages.push(message);
                return;
            }
            self.abort();
        }
        let _ = self.delivery.events.send(message);
    }

    fn abort(&mut self) {
        if let Some(pending) = &self.pending {
            pending.result.send_replace(Some(false));
        }
        self.flush();
    }

    fn flush(&mut self) {
        if let Some(pending) = self.pending.take() {
            for message in pending.messages {
                let _ = self.delivery.events.send(message);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn renderer(
        name: &str,
    ) -> (
        TerminalDelivery,
        mpsc::UnboundedReceiver<InvokeResponseBody>,
    ) {
        let (send, receive) = mpsc::unbounded_channel();
        let events = Channel::new(move |message| {
            send.send(message).unwrap();
            Ok(())
        });
        (
            TerminalDelivery {
                webview: name.into(),
                events,
                prompts: None,
            },
            receive,
        )
    }

    fn output(receive: &mut mpsc::UnboundedReceiver<InvokeResponseBody>) -> Vec<u8> {
        match receive.try_recv().unwrap() {
            InvokeResponseBody::Raw(bytes) => bytes,
            InvokeResponseBody::Json(_) => panic!("expected terminal output"),
        }
    }

    #[test]
    fn sampling_ignores_stale_changes_but_ends_on_handoff_or_exit() {
        use tokio::sync::oneshot::error::TryRecvError;

        let (source, _messages) = renderer("source");
        let route = TerminalRoute::new(source);
        let mut first = route
            .lock()
            .start_resources(1, ResourceInterval::default())
            .unwrap()
            .stopped;
        let mut second = route
            .lock()
            .start_resources(2, ResourceInterval::default())
            .unwrap();
        assert_eq!(first.try_recv(), Err(TryRecvError::Closed));
        route.lock().stop_resource_subscription(1);
        route
            .lock()
            .set_resource_interval(1, ResourceInterval::OneSecond);
        assert_eq!(second.stopped.try_recv(), Err(TryRecvError::Empty));
        assert_eq!(*second.interval.borrow(), ResourceInterval::TwoSeconds);
        route
            .lock()
            .set_resource_interval(2, ResourceInterval::FiveSeconds);
        assert_eq!(*second.interval.borrow(), ResourceInterval::FiveSeconds);

        let (result, _) = watch::channel(None);
        assert!(route.lock().prepare("move", &result));
        assert_eq!(second.stopped.try_recv(), Err(TryRecvError::Closed));
        assert!(route
            .lock()
            .start_resources(3, ResourceInterval::default())
            .is_none());

        route.lock().rollback("move");
        let mut third = route
            .lock()
            .start_resources(3, ResourceInterval::default())
            .unwrap()
            .stopped;
        route.connection_event(&TerminalEvent::Exit { code: Some(0) });
        assert_eq!(third.try_recv(), Err(TryRecvError::Closed));
        assert!(route
            .lock()
            .start_resources(4, ResourceInterval::default())
            .is_none());
    }

    #[test]
    fn moving_a_terminal_sends_each_side_of_the_fence_to_one_window() {
        let (source, mut old) = renderer("source");
        let (target, mut new) = renderer("target");
        let route = TerminalRoute::new(source);
        let (result, _) = watch::channel(None);
        route.send(InvokeResponseBody::Raw(b"before".to_vec()));
        assert!(route.lock().prepare("move", &result));
        route.send(InvokeResponseBody::Raw(b"during".to_vec()));

        assert_eq!(output(&mut old), b"before");
        assert!(
            matches!(old.try_recv(), Ok(InvokeResponseBody::Json(fence)) if fence == r#"{"moveFence":"move"}"#)
        );
        assert!(old.try_recv().is_err());
        assert!(new.try_recv().is_err());

        route.lock().adopt(target);
        route.send(InvokeResponseBody::Raw(b"after".to_vec()));
        assert_eq!(output(&mut new), b"during");
        assert_eq!(output(&mut new), b"after");
        assert!(old.try_recv().is_err());
    }

    #[test]
    fn a_closed_destination_or_output_overflow_resumes_the_source_in_order() {
        for overflow in [false, true] {
            let (source, mut old) = renderer("source");
            let route = TerminalRoute::new(source);
            let (result, state) = watch::channel(None);
            assert!(route.lock().prepare("move", &result));
            assert!(matches!(old.try_recv(), Ok(InvokeResponseBody::Json(_))));
            route.send(InvokeResponseBody::Raw(b"pending".to_vec()));

            if overflow {
                let chunk = vec![b'!'; MAX_PENDING_BYTES];
                route.send(InvokeResponseBody::Raw(chunk.clone()));
                assert_eq!(*state.borrow(), Some(false));
                assert_eq!(output(&mut old), b"pending");
                assert_eq!(output(&mut old), chunk);
            } else {
                route.lock().rollback("move");
                assert_eq!(output(&mut old), b"pending");
            }
            route.send(InvokeResponseBody::Raw(b"live".to_vec()));
            assert_eq!(output(&mut old), b"live");
        }
    }
}
