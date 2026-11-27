use std::cell::Cell;
use std::rc::Rc;

use sshastra_core::files::TransferSettings;

use super::*;

#[test]
fn weights_progress_by_bytes_without_overflowing_or_overcounting() {
    assert_eq!(aggregate([]), Progress::Hidden);
    assert_eq!(aggregate([(20, 20), (20, 180)]), Progress::Percent(20));
    assert_eq!(aggregate([(20, 20), (0, 0)]), Progress::Indeterminate);
    assert_eq!(
        aggregate([(u64::MAX, 10), (u64::MAX / 2, u64::MAX), (0, u64::MAX)]),
        Progress::Percent(25)
    );
}

#[test]
fn one_lease_follows_running_transfers_and_the_setting_until_shutdown() {
    let activity = Activity::new();
    let opened = Cell::new(0);
    let closed = Rc::new(Cell::new(0));
    let mut sleep = SleepActivity::default();
    let mut check = |expected_progress, expected_opened, expected_closed| {
        let status = activity.status();
        assert_eq!(status.progress, expected_progress);
        sleep.update(status.inhibit_sleep, || {
            opened.set(opened.get() + 1);
            Some(Lease(Rc::clone(&closed)))
        });
        assert_eq!(
            (opened.get(), closed.get()),
            (expected_opened, expected_closed)
        );
    };

    let id = |id: u64| serde_json::from_value(id.into()).unwrap();
    activity.transfer(id(1), &TransferState::Queued, (0, 0));
    check(Progress::Hidden, 0, 0);
    activity.transfer(id(1), &TransferState::Running, (20, 100));
    check(Progress::Percent(20), 1, 0);
    activity.transfer(id(2), &TransferState::Running, (40, 100));
    check(Progress::Percent(30), 1, 0);
    activity.transfer(id(1), &TransferState::Paused, (20, 100));
    check(Progress::Percent(40), 1, 0);
    activity.set_prevent_sleep(false);
    check(Progress::Percent(40), 1, 1);
    activity.set_prevent_sleep(true);
    check(Progress::Percent(40), 2, 1);
    activity.transfer(
        id(2),
        &TransferState::Conflict {
            path: String::new(),
        },
        (40, 100),
    );
    check(Progress::Hidden, 2, 2);
    activity.transfer(id(2), &TransferState::Running, (40, 100));
    check(Progress::Percent(40), 3, 2);
    activity.transfer(
        id(2),
        &TransferState::Failed {
            message: String::new(),
        },
        (40, 100),
    );
    check(Progress::Hidden, 3, 3);
    activity.transfer(id(3), &TransferState::Running, (0, 0));
    check(Progress::Indeterminate, 4, 3);
    activity.transfer(id(3), &TransferState::Done, (100, 100));
    check(Progress::Hidden, 4, 4);
    activity.transfer(id(4), &TransferState::Running, (0, 0));
    check(Progress::Indeterminate, 5, 4);
    activity.shutdown();
    activity.transfer(id(5), &TransferState::Running, (0, 0));
    check(Progress::Hidden, 5, 5);
}

#[test]
fn unavailable_power_provider_is_retried_on_the_next_activity() {
    let mut count = 0;
    let mut sleep = SleepActivity::<Lease>::default();
    let mut acquire = || {
        count += 1;
        None
    };
    sleep.update(true, &mut acquire);
    sleep.update(true, &mut acquire);
    sleep.update(false, &mut acquire);
    sleep.update(true, &mut acquire);
    assert_eq!(count, 2);
}

#[test]
fn saved_transfer_settings_keep_an_explicit_sleep_opt_out() {
    let old: TransferSettings = serde_json::from_str(r#"{"concurrency":5}"#).unwrap();
    assert_eq!(old.concurrency(), 5);
    assert!(old.prevent_sleep);
    let saved: TransferSettings = serde_json::from_str(r#"{"preventSleep":false}"#).unwrap();
    assert!(!saved.prevent_sleep);
}

struct Lease(Rc<Cell<usize>>);

impl Drop for Lease {
    fn drop(&mut self) {
        self.0.set(self.0.get() + 1);
    }
}
