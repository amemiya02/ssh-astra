//! The time limit on an SSH handshake and authentication. It counts only
//! time spent waiting on the server: while the user is answering a prompt
//! (or a keychain dialog is up) the clock stands still.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;
use tokio::time::Instant;

use super::{
    BoxFuture, HostKeyDecision, HostKeyPrompt, KeyboardInteractivePrompt, PassphrasePrompt,
    PasswordPrompt, Prompter, Secret,
};

/// A time budget that can be paused.
pub(super) struct Deadline {
    state: Mutex<State>,
    changed: Notify,
}

struct State {
    /// Budget left when the clock last stopped (or started).
    left: Duration,
    /// When the clock last started; `None` while paused.
    since: Option<Instant>,
    /// Pauses in progress (prompts can overlap).
    pauses: u32,
}

impl Deadline {
    pub(super) fn new(budget: Duration) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                left: budget,
                since: Some(Instant::now()),
                pauses: 0,
            }),
            changed: Notify::new(),
        })
    }

    /// Stops the clock until the returned guard is dropped.
    pub(super) fn pause(self: &Arc<Self>) -> Pause {
        let mut state = self.lock();
        if state.pauses == 0 {
            if let Some(since) = state.since.take() {
                state.left = state.left.saturating_sub(since.elapsed());
            }
        }
        state.pauses += 1;
        drop(state);
        self.changed.notify_waiters();
        Pause(Arc::clone(self))
    }

    /// When the budget runs out, or `None` while paused.
    fn expires_at(&self) -> Option<Instant> {
        let state = self.lock();
        state.since.map(|since| since + state.left)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Restarts the clock when dropped (once no other pause is in progress).
pub(super) struct Pause(Arc<Deadline>);

impl Drop for Pause {
    fn drop(&mut self) {
        let mut state = self.0.lock();
        state.pauses -= 1;
        if state.pauses == 0 {
            state.since = Some(Instant::now());
        }
        drop(state);
        self.0.changed.notify_waiters();
    }
}

/// Runs `work` until it finishes or `deadline` runs out (`None`).
pub(super) async fn within<F: Future>(deadline: &Deadline, work: F) -> Option<F::Output> {
    tokio::pin!(work);
    loop {
        let changed = deadline.changed.notified();
        tokio::pin!(changed);
        // Registered before reading the state, so a pause in between is seen.
        changed.as_mut().enable();
        let expiry = deadline.expires_at();
        tokio::select! {
            out = &mut work => return Some(out),
            () = sleep_until(expiry) => {
                if deadline.expires_at().is_some_and(|at| at <= Instant::now()) {
                    return None;
                }
            }
            () = &mut changed => {}
        }
    }
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// A [`Prompter`] that stops `deadline` while each question is open.
pub(super) struct Paused {
    pub(super) inner: Arc<dyn Prompter>,
    pub(super) deadline: Arc<Deadline>,
}

impl Prompter for Paused {
    fn confirm_host_key(&self, prompt: HostKeyPrompt) -> BoxFuture<'_, HostKeyDecision> {
        Box::pin(async move {
            let _pause = self.deadline.pause();
            self.inner.confirm_host_key(prompt).await
        })
    }

    fn password(&self, prompt: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        Box::pin(async move {
            let _pause = self.deadline.pause();
            self.inner.password(prompt).await
        })
    }

    fn passphrase(&self, prompt: PassphrasePrompt) -> BoxFuture<'_, Option<Secret>> {
        Box::pin(async move {
            let _pause = self.deadline.pause();
            self.inner.passphrase(prompt).await
        })
    }

    fn keyboard_interactive(
        &self,
        prompt: KeyboardInteractivePrompt,
    ) -> BoxFuture<'_, Option<Vec<String>>> {
        Box::pin(async move {
            let _pause = self.deadline.pause();
            self.inner.keyboard_interactive(prompt).await
        })
    }
}
