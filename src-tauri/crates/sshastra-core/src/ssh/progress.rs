//! Progress a caller can show while opening a Connection or Terminal.

use std::time::Instant;

use serde::Serialize;

use super::Prompter;
use crate::hosts::{Host, HostId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectStage {
    Waiting,
    Reach,
    HostKey,
    Authenticate,
    Shell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProgressStatus {
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthMethod {
    None,
    Agent,
    KeyFile,
    Password,
    KeyboardInteractive,
}

/// A step starting, changing authentication method, or ending. The elapsed
/// time is wall time for the step, including time spent answering questions.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectProgress {
    pub host_id: HostId,
    pub host_name: String,
    pub jump_host: bool,
    pub stage: ConnectStage,
    pub status: ProgressStatus,
    pub elapsed_ms: u64,
    pub method: Option<AuthMethod>,
}

#[derive(Clone, Copy)]
pub(super) struct HopProgress<'a> {
    pub(super) host: &'a Host,
    pub(super) jump_host: bool,
    pub(super) prompter: &'a dyn Prompter,
}

impl<'a> HopProgress<'a> {
    pub(super) fn start(self, stage: ConnectStage) -> ActiveStep<'a> {
        let step = ActiveStep {
            hop: self,
            stage,
            since: Instant::now(),
            method: None,
            finished: false,
        };
        step.report(ProgressStatus::Running);
        step
    }
}

pub(super) struct ActiveStep<'a> {
    hop: HopProgress<'a>,
    stage: ConnectStage,
    since: Instant,
    method: Option<AuthMethod>,
    finished: bool,
}

impl ActiveStep<'_> {
    pub(super) fn method(&mut self, method: AuthMethod) {
        self.method = Some(method);
        self.report(ProgressStatus::Running);
    }

    pub(super) fn finish<T, E>(self, result: Result<T, E>) -> Result<T, E> {
        self.end(if result.is_ok() {
            ProgressStatus::Succeeded
        } else {
            ProgressStatus::Failed
        });
        result
    }

    pub(super) fn end(mut self, status: ProgressStatus) {
        self.finished = true;
        self.report(status);
    }

    fn report(&self, status: ProgressStatus) {
        self.hop.prompter.progress(ConnectProgress {
            host_id: self.hop.host.id.clone(),
            host_name: self.hop.host.name.clone(),
            jump_host: self.hop.jump_host,
            stage: self.stage,
            status,
            elapsed_ms: self.since.elapsed().as_millis() as u64,
            method: self.method,
        });
    }
}

impl Drop for ActiveStep<'_> {
    fn drop(&mut self) {
        // A handshake timeout drops whichever step is still in flight.
        if !self.finished {
            self.report(ProgressStatus::Failed);
        }
    }
}
