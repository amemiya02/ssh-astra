//! Install a watcher and sample its initial state under the same lock used for sending
//! changes. Core listeners run after releasing their domain locks.

use std::sync::Mutex;
use tauri::ipc::{Channel, IpcResponse};

pub struct Watcher<E>(Mutex<Option<Channel<E>>>);

impl<E> Default for Watcher<E> {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

impl<E: IpcResponse> Watcher<E> {
    pub fn subscribe<S>(&self, channel: Channel<E>, snapshot: impl FnOnce() -> S) -> S {
        let mut current = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let initial = snapshot();
        *current = Some(channel);
        initial
    }

    pub fn send(&self, event: E) {
        if let Some(channel) = self.0.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            let _ = channel.send(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn a_send_during_registration_reaches_the_new_channel() {
        let watcher = Watcher::<u32>::default();
        watcher.subscribe(Channel::new(|_| panic!("superseded channel")), || ());

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
            let initial = watcher.subscribe(channel, || {
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
