use std::collections::HashMap;
use std::sync::Mutex;

use sshastra_core::files::{TransferId, TransferState};

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Summary {
    pub(super) completed: usize,
    pub(super) failed: usize,
    pub(super) cancelled: usize,
}

struct Batch {
    remaining: usize,
    summary: Summary,
}

#[derive(Clone, Copy)]
enum Outcome {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Default)]
struct Pending {
    enqueuing: usize,
    next_batch: usize,
    batches: HashMap<usize, Batch>,
    batch_by_transfer: HashMap<TransferId, usize>,
    finished_during_enqueue: HashMap<TransferId, Outcome>,
}

impl Pending {
    fn finish(&mut self, id: TransferId, outcome: Outcome) -> Option<Summary> {
        let Some(batch_id) = self.batch_by_transfer.remove(&id) else {
            if self.enqueuing > 0 {
                self.finished_during_enqueue.entry(id).or_insert(outcome);
            }
            return None;
        };
        let batch = self.batches.get_mut(&batch_id).expect("tracked batch");
        match outcome {
            Outcome::Completed => batch.summary.completed += 1,
            Outcome::Failed => batch.summary.failed += 1,
            Outcome::Cancelled => batch.summary.cancelled += 1,
        }
        batch.remaining -= 1;
        if batch.remaining == 0 {
            self.batches.remove(&batch_id).map(|batch| batch.summary)
        } else {
            None
        }
    }
}

/// Tracks each enqueue request in the app process so the initiating Window can close.
#[derive(Default)]
pub(super) struct TransferBatches(Mutex<Pending>);

impl TransferBatches {
    pub(super) fn track(
        &self,
        enqueue: impl FnOnce() -> Vec<TransferId>,
    ) -> (Vec<TransferId>, Option<Summary>) {
        self.0.lock().unwrap().enqueuing += 1;
        // Queue listeners may run synchronously while enqueueing.
        let ids = enqueue();
        let mut pending = self.0.lock().unwrap();
        let mut summary = None;
        if !ids.is_empty() {
            pending.next_batch += 1;
            let batch = pending.next_batch;
            pending.batches.insert(
                batch,
                Batch {
                    remaining: ids.len(),
                    summary: Summary::default(),
                },
            );
            for id in &ids {
                pending.batch_by_transfer.insert(*id, batch);
                if let Some(outcome) = pending.finished_during_enqueue.remove(id) {
                    summary = pending.finish(*id, outcome).or(summary);
                }
            }
        }
        pending.enqueuing -= 1;
        if pending.enqueuing == 0 {
            pending.finished_during_enqueue.clear();
        }
        (ids, summary)
    }

    pub(super) fn changed(&self, id: TransferId, state: &TransferState) -> Option<Summary> {
        let outcome = match state {
            TransferState::Done => Outcome::Completed,
            TransferState::Failed { .. } => Outcome::Failed,
            TransferState::Cancelled => Outcome::Cancelled,
            _ => return None,
        };
        self.0.lock().unwrap().finish(id, outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u64) -> TransferId {
        serde_json::from_value(n.into()).unwrap()
    }

    #[test]
    fn counts_early_results_and_finishes_each_app_batch_once() {
        let batches = TransferBatches::default();
        let (_, summary) = batches.track(|| {
            assert_eq!(batches.changed(id(1), &TransferState::Done), None);
            assert_eq!(batches.changed(id(1), &TransferState::Cancelled), None);
            vec![id(1), id(2)]
        });
        assert_eq!(summary, None);

        let (_, summary) = batches.track(|| {
            assert_eq!(batches.changed(id(3), &TransferState::Cancelled), None);
            vec![id(3)]
        });
        assert_eq!(
            summary,
            Some(Summary {
                cancelled: 1,
                ..Summary::default()
            })
        );

        assert_eq!(batches.changed(id(2), &TransferState::Running), None);
        let failed = TransferState::Failed {
            message: "lost connection".into(),
        };
        assert_eq!(
            batches.changed(id(2), &failed),
            Some(Summary {
                completed: 1,
                failed: 1,
                cancelled: 0
            }),
        );
        assert_eq!(batches.changed(id(2), &failed), None);
    }
}
