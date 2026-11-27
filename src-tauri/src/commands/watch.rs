//! Install a watcher and sample its initial state under the same lock used for sending
//! changes. Core listeners run after releasing their domain locks.

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::ipc::{Channel, IpcResponse};

pub struct Watcher<E>(Mutex<HashMap<String, Channel<E>>>);

impl<E> Default for Watcher<E> {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

impl<E: Clone + IpcResponse> Watcher<E> {
    pub fn subscribe<S>(
        &self,
        window: &str,
        channel: Channel<E>,
        snapshot: impl FnOnce() -> S,
    ) -> S {
        let mut current = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let initial = snapshot();
        current.insert(window.to_owned(), channel);
        initial
    }

    pub fn send(&self, event: E) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|_, channel| channel.send(event.clone()).is_ok());
    }

    pub fn send_to(&self, window: &str, event: E) {
        if let Some(channel) = self.0.lock().unwrap_or_else(|p| p.into_inner()).get(window) {
            let _ = channel.send(event);
        }
    }

    pub fn unsubscribe(&self, window: &str) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(window);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn closing_one_window_leaves_the_other_window_subscribed() {
        let watcher = Watcher::<u32>::default();
        let (first, first_events) = mpsc::channel();
        let (second, second_events) = mpsc::channel();
        watcher.subscribe(
            "main",
            Channel::new(move |body| {
                first.send(body).unwrap();
                Ok(())
            }),
            || (),
        );
        watcher.subscribe(
            "window-1",
            Channel::new(move |body| {
                second.send(body).unwrap();
                Ok(())
            }),
            || (),
        );
        watcher.send(1);
        watcher.unsubscribe("main");
        watcher.send(2);
        assert_eq!(first_events.try_iter().count(), 1);
        assert_eq!(second_events.try_iter().count(), 2);
    }

    #[test]
    fn a_send_during_registration_reaches_the_new_channel() {
        let watcher = Watcher::<u32>::default();
        watcher.subscribe(
            "main",
            Channel::new(|_| panic!("superseded channel")),
            || (),
        );

        let (sent, received) = mpsc::channel();
        let channel = Channel::new(move |body| {
            sent.send(body).unwrap();
            Ok(())
        });
        std::thread::scope(|threads| {
            let (reading, wait) = mpsc::sync_channel(0);
            let watcher = &watcher;
            threads.spawn(move || {
                wait.recv().unwrap();
                watcher.send(2);
            });
            let initial = watcher.subscribe("main", channel, || {
                reading.send(()).unwrap();
                1
            });
            assert_eq!(initial, 1);
        });
        assert!(matches!(
            received.try_recv().unwrap(),
            tauri::ipc::InvokeResponseBody::Json(value) if value == "2"
        ));
    }
}
