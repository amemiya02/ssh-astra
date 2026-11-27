use std::collections::VecDeque;
use std::sync::Mutex;

const MAX_PENDING_LAUNCHES: usize = 16;
const MAX_ARGUMENTS: usize = 64;
const MAX_LAUNCH_BYTES: usize = 16 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ForwardedLaunch {
    pub(crate) argv: Vec<String>,
    pub(crate) cwd: String,
}

#[derive(Default)]
pub(crate) struct PendingLaunches(Mutex<Pending>);

#[derive(Default)]
struct Pending {
    launches: VecDeque<ForwardedLaunch>,
    ready: bool,
    activation_pending: bool,
}

impl Pending {
    fn request_activation(&mut self) -> bool {
        let was_pending = std::mem::replace(&mut self.activation_pending, true);
        self.ready && !was_pending
    }
}

impl PendingLaunches {
    /// Keeps forwarded data in arrival order. Returns whether to schedule activation now.
    pub(super) fn forward(&self, argv: Vec<String>, cwd: String) -> bool {
        let mut pending = self.0.lock().unwrap();
        // argv[0] is the executable. Plain launches only need window activation.
        if (2..=MAX_ARGUMENTS).contains(&argv.len())
            && cwd.len() + argv.iter().map(String::len).sum::<usize>() <= MAX_LAUNCH_BYTES
        {
            if pending.launches.len() == MAX_PENDING_LAUNCHES {
                pending.launches.pop_front();
            }
            pending.launches.push_back(ForwardedLaunch { argv, cwd });
        }
        pending.request_activation()
    }

    #[cfg(target_os = "macos")]
    pub(super) fn reopen(&self) -> bool {
        self.0.lock().unwrap().request_activation()
    }

    pub(super) fn ready(&self) -> bool {
        let mut pending = self.0.lock().unwrap();
        pending.ready = true;
        std::mem::take(&mut pending.activation_pending)
    }

    pub(super) fn take_activation(&self) -> bool {
        std::mem::take(&mut self.0.lock().unwrap().activation_pending)
    }

    /// Drains the inbox once a native consumer is ready to handle the data.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "consumer will arrive with #140")
    )]
    pub(crate) fn take_pending(&self) -> VecDeque<ForwardedLaunch> {
        std::mem::take(&mut self.0.lock().unwrap().launches)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwarded_arguments_survive_native_readiness_until_taken() {
        let launches = PendingLaunches::default();
        let argv = vec!["sshastra".into(), "--unknown".into(), "a | b".into()];
        let cwd = "/a directory".to_owned();

        assert!(!launches.forward(argv.clone(), cwd.clone()));
        assert!(launches.ready());
        assert!(!launches.take_activation());

        assert_eq!(launches.take_pending(), [ForwardedLaunch { argv, cwd }]);
        assert!(launches.take_pending().is_empty());
    }

    #[test]
    fn ready_launches_coalesce_activation_without_losing_arguments() {
        let launches = PendingLaunches::default();
        assert!(!launches.ready());

        assert!(launches.forward(vec!["sshastra".into()], "/first".into()));
        assert!(!launches.forward(vec!["sshastra".into(), "first".into()], "/second".into()));
        assert!(launches.take_activation());
        assert!(!launches.take_activation());
        assert!(launches.forward(vec!["sshastra".into(), "second".into()], "/third".into()));

        assert_eq!(
            launches.take_pending(),
            [
                ForwardedLaunch {
                    argv: vec!["sshastra".into(), "first".into()],
                    cwd: "/second".into(),
                },
                ForwardedLaunch {
                    argv: vec!["sshastra".into(), "second".into()],
                    cwd: "/third".into(),
                },
            ]
        );
        assert!(launches.take_activation());
    }

    #[test]
    fn overflowing_the_inbox_keeps_the_most_recent_launches_in_order() {
        let launches = PendingLaunches::default();
        for index in 0..=MAX_PENDING_LAUNCHES {
            launches.forward(vec!["sshastra".into(), index.to_string()], String::new());
        }

        let queued = launches.take_pending();
        assert_eq!(queued.len(), MAX_PENDING_LAUNCHES);
        for (index, launch) in queued.into_iter().enumerate() {
            assert_eq!(launch.argv[1], (index + 1).to_string());
        }
        assert!(launches.ready());
    }

    #[test]
    fn oversized_requests_still_activate_the_window() {
        let launches = PendingLaunches::default();
        launches.ready();

        assert!(launches.forward(vec!["x".into(); MAX_ARGUMENTS + 1], String::new()));
        assert!(launches.take_activation());
        assert!(launches.forward(
            vec!["sshastra".into(), "x".repeat(MAX_LAUNCH_BYTES)],
            String::new()
        ));
        assert!(launches.take_activation());
        assert!(launches.take_pending().is_empty());
    }
}
