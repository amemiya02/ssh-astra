//! App-wide transfer progress and idle sleep protection. Queue events are ordered
//! and already throttled, and only running transfers contribute to either effect.

mod sleep;

#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sshastra_core::files::{Transfer, TransferId, TransferState};
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::sync::watch;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Progress {
    #[default]
    Hidden,
    Indeterminate,
    Percent(u64),
}

fn aggregate(bytes: impl IntoIterator<Item = (u64, u64)>) -> Progress {
    let mut sum_done = 0u128;
    let mut sum_total = 0u128;
    for (done, total) in bytes {
        // The queue reports zero while discovering the source size.
        if total == 0 {
            return Progress::Indeterminate;
        }
        sum_done += u128::from(done.min(total));
        sum_total += u128::from(total);
    }
    if sum_total == 0 {
        Progress::Hidden
    } else {
        Progress::Percent((sum_done * 100 / sum_total) as u64)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Status {
    progress: Progress,
    inhibit_sleep: bool,
    stopped: bool,
}

#[derive(Default)]
struct RunningTransfers {
    bytes: HashMap<TransferId, (u64, u64)>,
    prevent_sleep: bool,
    stopped: bool,
}

/// The queue listener keeps only the scalar progress of running transfers.
/// `watch` coalesces updates when the desktop is busy and wakes on the last completion.
pub(crate) struct Activity {
    running: Mutex<RunningTransfers>,
    status: watch::Sender<Status>,
}

impl Activity {
    fn new() -> Self {
        Self {
            running: Mutex::new(RunningTransfers {
                prevent_sleep: true,
                ..Default::default()
            }),
            status: watch::Sender::new(Status::default()),
        }
    }

    pub(crate) fn start(app: &AppHandle) -> Arc<Self> {
        let activity = Arc::new(Self::new());
        let mut status = activity.status.subscribe();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            while status.changed().await.is_ok() {
                if status.borrow_and_update().stopped {
                    break;
                }
                let latest = status.clone();
                let main = app.clone();
                if app
                    .run_on_main_thread(move || {
                        let status = *latest.borrow();
                        present(&main, status);
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        activity
    }

    pub(crate) fn changed(&self, transfer: &Transfer) {
        self.transfer(
            transfer.id,
            &transfer.state,
            (transfer.bytes_done, transfer.bytes_total),
        );
    }

    fn transfer(&self, id: TransferId, state: &TransferState, bytes: (u64, u64)) {
        let mut running = self.running.lock().unwrap();
        if running.stopped {
            return;
        }
        let changed = if matches!(state, TransferState::Running) {
            running.bytes.insert(id, bytes) != Some(bytes)
        } else {
            running.bytes.remove(&id).is_some()
        };
        if changed {
            self.publish(&running);
        }
    }

    pub(crate) fn set_prevent_sleep(&self, enabled: bool) {
        let mut running = self.running.lock().unwrap();
        if running.prevent_sleep != enabled && !running.stopped {
            running.prevent_sleep = enabled;
            self.publish(&running);
        }
    }

    fn publish(&self, running: &RunningTransfers) {
        self.status.send_if_modified(|previous| {
            let status = Status {
                progress: aggregate(running.bytes.values().copied()),
                inhibit_sleep: running.prevent_sleep && !running.bytes.is_empty(),
                stopped: running.stopped,
            };
            let changed = *previous != status;
            *previous = status;
            changed
        });
    }

    fn status(&self) -> Status {
        *self.status.borrow()
    }

    pub(crate) fn window_opened(&self, window: &WebviewWindow) {
        if self.status().progress == Progress::Hidden {
            return;
        }
        let latest = self.status.subscribe();
        let new_window = window.clone();
        // Read the current value on the same thread that applies updates to existing Windows.
        let _ = window.run_on_main_thread(move || {
            let progress = latest.borrow().progress;
            if progress != Progress::Hidden {
                set_progress(&new_window, progress);
            }
        });
    }

    #[cfg(windows)]
    pub(crate) fn resumed(&self, app: &AppHandle) {
        // Windows retires SystemRequired requests when the user explicitly sleeps.
        let latest = self.status.subscribe();
        let _ = app.run_on_main_thread(move || {
            let requested = latest.borrow().inhibit_sleep && !cfg!(feature = "e2e");
            PRESENTATION.with_borrow_mut(|presentation| {
                presentation.sleep.update(false, || None);
                presentation.sleep.update(requested, sleep::acquire);
            });
        });
    }

    fn shutdown(&self) {
        let mut running = self.running.lock().unwrap();
        running.stopped = true;
        running.bytes.clear();
        self.publish(&running);
    }

    /// Called on the event-loop thread before the process exits.
    pub(crate) fn stop(&self, app: &AppHandle) {
        self.shutdown();
        present(app, self.status());
    }
}

struct SleepActivity<L> {
    requested: bool,
    lease: Option<L>,
}

impl<L> Default for SleepActivity<L> {
    fn default() -> Self {
        Self {
            requested: false,
            lease: None,
        }
    }
}

impl<L> SleepActivity<L> {
    fn update(&mut self, requested: bool, acquire: impl FnOnce() -> Option<L>) {
        if self.requested != requested {
            self.requested = requested;
            self.lease = if requested { acquire() } else { None };
        }
    }
}

#[derive(Default)]
struct Presentation {
    progress: Progress,
    sleep: SleepActivity<sleep::Lease>,
}

// The macOS activity token stays on the event-loop thread for its whole lifetime.
thread_local! {
    static PRESENTATION: RefCell<Presentation> = RefCell::default();
}

fn present(app: &AppHandle, status: Status) {
    PRESENTATION.with_borrow_mut(|presentation| {
        // Test builds never hold a power request on the developer's desktop.
        presentation.sleep.update(
            status.inhibit_sleep && !cfg!(feature = "e2e"),
            sleep::acquire,
        );
        if presentation.progress != status.progress {
            presentation.progress = status.progress;
            let windows = app.webview_windows();
            if cfg!(windows) {
                for window in windows.values() {
                    set_progress(window, status.progress);
                }
            } else if let Some(window) = windows.values().next() {
                // The Dock and Linux launcher each have one progress bar per app.
                set_progress(window, status.progress);
            }
        }
    });
}

fn set_progress(window: &WebviewWindow, progress: Progress) {
    let (status, progress) = match progress {
        Progress::Hidden => (ProgressBarStatus::None, None),
        // Windows animates indeterminate work. On Dock and Unity, reset the visible bar to zero.
        Progress::Indeterminate => (
            ProgressBarStatus::Indeterminate,
            (!cfg!(windows)).then_some(0),
        ),
        Progress::Percent(percent) => (ProgressBarStatus::Normal, Some(percent)),
    };
    if let Err(error) = window.set_progress_bar(ProgressBarState {
        status: Some(status),
        progress,
    }) {
        log::debug!("could not update transfer progress on the desktop: {error}");
    }
}
