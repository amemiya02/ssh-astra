use std::collections::VecDeque;
use std::sync::Mutex;

use super::ssh_link::SshLinkTarget;

pub(super) const MAX_PENDING_LAUNCHES: usize = 16;

#[derive(Default)]
pub(crate) struct PendingLaunches(Mutex<Pending>);

#[derive(Default)]
struct Pending {
    links: VecDeque<(Option<String>, SshLinkTarget)>,
    ready: bool,
    activation_pending: bool,
}

impl PendingLaunches {
    /// Keeps only parsed destinations. A plain second launch still requests activation.
    pub(super) fn forward(&self, links: impl IntoIterator<Item = SshLinkTarget>) -> bool {
        let mut pending = self.0.lock().unwrap();
        for link in links {
            if pending.links.len() == MAX_PENDING_LAUNCHES {
                pending.links.pop_front();
            }
            pending.links.push_back((None, link));
        }
        let was_pending = std::mem::replace(&mut pending.activation_pending, true);
        pending.ready && !was_pending
    }

    pub(super) fn ready(&self) -> bool {
        let mut pending = self.0.lock().unwrap();
        pending.ready = true;
        std::mem::take(&mut pending.activation_pending)
    }

    pub(super) fn take_activation(&self) -> bool {
        std::mem::take(&mut self.0.lock().unwrap().activation_pending)
    }

    /// Binds unclaimed links to the same window the native launch activates.
    pub(super) fn target_for_activation(&self, label: &str) -> bool {
        let mut pending = self.0.lock().unwrap();
        let mut has_links = false;
        for (owner, _) in &mut pending.links {
            if owner.get_or_insert_with(|| label.to_owned()) == label {
                has_links = true;
            }
        }
        has_links
    }

    pub(super) fn take_links(&self, label: &str) -> Vec<SshLinkTarget> {
        let mut pending = self.0.lock().unwrap();
        let mut links = Vec::new();
        for (owner, link) in std::mem::take(&mut pending.links) {
            if owner.as_deref() == Some(label) {
                links.push(link);
            } else {
                pending.links.push_back((owner, link));
            }
        }
        links
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launch::ssh_link::parse;

    #[test]
    fn cold_links_survive_readiness_and_only_the_target_window_can_drain_them() {
        let launches = PendingLaunches::default();
        let first = || parse("ssh://u:sensitive@one.test", None).unwrap();
        let second = || parse("ssh://u@two.test", None).unwrap();

        assert!(!launches.forward([first(), second()]));
        assert!(launches.take_links("main").is_empty());
        assert!(launches.ready());
        assert!(!launches.take_activation());
        assert!(launches.target_for_activation("main"));
        assert!(!launches.target_for_activation("other"));
        assert!(launches.take_links("other").is_empty());
        assert_eq!(launches.take_links("main"), [first(), second()]);
        assert!(launches.take_links("main").is_empty());
    }

    #[test]
    fn ready_launches_coalesce_activation_without_losing_links() {
        let launches = PendingLaunches::default();
        let link = || parse("ssh://u@one.test", None).unwrap();
        assert!(!launches.ready());
        assert!(launches.forward([]));
        assert!(!launches.forward([link()]));
        assert!(launches.take_activation());
        assert!(!launches.take_activation());
        assert!(launches.target_for_activation("main"));
        assert!(launches.forward([link()]));
        assert!(launches.take_activation());
        assert!(launches.target_for_activation("other"));
        assert_eq!(launches.take_links("other"), [link()]);
        assert_eq!(launches.take_links("main"), [link()]);
    }

    #[test]
    fn overflowing_the_inbox_keeps_recent_links_in_order() {
        let launches = PendingLaunches::default();
        let link = |index| parse(&format!("ssh://u@host-{index}.test"), None).unwrap();
        launches.forward((0..=MAX_PENDING_LAUNCHES).map(link));
        launches.target_for_activation("main");
        let queued = launches.take_links("main");
        assert_eq!(
            queued,
            (1..=MAX_PENDING_LAUNCHES).map(link).collect::<Vec<_>>()
        );
    }
}
