//! A [`Prompter`] that asks the user through the front end: each question is
//! pushed over a `Channel` with an id, and the UI replies with the
//! `prompt_answer` command carrying the same id. Progress on that Channel
//! has no id and needs no reply.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sshastra_core::ssh::{
    BoxFuture, ConnectProgress, HostKeyPrompt, KeyboardInteractivePrompt, PassphrasePrompt,
    PasswordPrompt, Prompter, Secret,
};
use sshastra_core::terminal::ConnectionState;
use tauri::ipc::Channel;
use tokio::sync::oneshot;

/// A question or progress update sent on a connect's prompt channel.
#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PromptRequest {
    Progress {
        progress: ConnectProgress,
    },
    Reconnect {
        state: ConnectionState,
    },
    HostKey {
        id: u64,
        host: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
    },
    Password {
        id: u64,
        host: String,
        user: String,
        retry: bool,
        /// Offer a "save" checkbox (the CredentialVault works).
        can_save: bool,
    },
    Passphrase {
        id: u64,
        key_path: String,
        retry: bool,
        can_save: bool,
    },
    KeyboardInteractive {
        id: u64,
        host: String,
        user: String,
        name: String,
        instructions: String,
        prompts: Vec<KeyboardInteractiveField>,
    },
}

/// One question of a keyboard-interactive round.
#[derive(Clone, Serialize)]
pub struct KeyboardInteractiveField {
    pub text: String,
    /// Show the answer while typing (false for secrets).
    pub echo: bool,
}

/// The user's reply, sent back with `prompt_answer`.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PromptAnswer {
    HostKey {
        trust: bool,
    },
    Password {
        password: Option<String>,
        /// Keep it in the CredentialVault once it works.
        #[serde(default)]
        save: bool,
    },
    Passphrase {
        passphrase: Option<String>,
        #[serde(default)]
        save: bool,
    },
    KeyboardInteractive {
        answers: Option<Vec<String>>,
    },
}

/// Prompts waiting for an answer, shared by every connect in progress.
#[derive(Default)]
pub struct PendingPrompts {
    next_id: AtomicU64,
    waiting: Mutex<HashMap<u64, oneshot::Sender<PromptAnswer>>>,
}

impl PendingPrompts {
    /// Delivers `answer` to the prompt `id`. Unknown ids (already answered or
    /// abandoned) are ignored.
    pub fn answer(&self, id: u64, answer: PromptAnswer) {
        if let Some(tx) = self.lock().remove(&id) {
            let _ = tx.send(answer);
        }
    }

    fn register(&self) -> (u64, oneshot::Receiver<PromptAnswer>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.lock().insert(id, tx);
        (id, rx)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<PromptAnswer>>> {
        self.waiting
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub struct ChannelPrompter {
    pub pending: Arc<PendingPrompts>,
    pub channel: Channel<PromptRequest>,
}

impl ChannelPrompter {
    /// Sends the request built for a fresh id and waits for the reply.
    /// `None` if the webview went away.
    async fn ask(&self, request: impl FnOnce(u64) -> PromptRequest) -> Option<PromptAnswer> {
        let (id, rx) = self.pending.register();
        if self.channel.send(request(id)).is_err() {
            self.pending.lock().remove(&id);
            return None;
        }
        rx.await.ok()
    }
}

impl Prompter for ChannelPrompter {
    fn progress(&self, progress: ConnectProgress) {
        let _ = self.channel.send(PromptRequest::Progress { progress });
    }

    fn confirm_host_key(&self, prompt: HostKeyPrompt) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            let answer = self
                .ask(|id| PromptRequest::HostKey {
                    id,
                    host: prompt.host,
                    port: prompt.port,
                    algorithm: prompt.algorithm,
                    fingerprint: prompt.fingerprint,
                })
                .await;
            matches!(answer, Some(PromptAnswer::HostKey { trust: true }))
        })
    }

    fn password(&self, prompt: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        Box::pin(async move {
            let answer = self
                .ask(|id| PromptRequest::Password {
                    id,
                    host: prompt.host,
                    user: prompt.user,
                    retry: prompt.retry,
                    can_save: prompt.can_save,
                })
                .await;
            match answer {
                Some(PromptAnswer::Password { password, save }) => {
                    password.map(|value| Secret { value, save })
                }
                _ => None,
            }
        })
    }

    fn passphrase(&self, prompt: PassphrasePrompt) -> BoxFuture<'_, Option<Secret>> {
        Box::pin(async move {
            let answer = self
                .ask(|id| PromptRequest::Passphrase {
                    id,
                    key_path: prompt.key_path.display().to_string(),
                    retry: prompt.retry,
                    can_save: prompt.can_save,
                })
                .await;
            match answer {
                Some(PromptAnswer::Passphrase { passphrase, save }) => {
                    passphrase.map(|value| Secret { value, save })
                }
                _ => None,
            }
        })
    }

    fn keyboard_interactive(
        &self,
        prompt: KeyboardInteractivePrompt,
    ) -> BoxFuture<'_, Option<Vec<String>>> {
        Box::pin(async move {
            let count = prompt.prompts.len();
            let answer = self
                .ask(|id| PromptRequest::KeyboardInteractive {
                    id,
                    host: prompt.host,
                    user: prompt.user,
                    name: prompt.name,
                    instructions: prompt.instructions,
                    prompts: prompt
                        .prompts
                        .into_iter()
                        .map(|q| KeyboardInteractiveField {
                            text: q.text,
                            echo: q.echo,
                        })
                        .collect(),
                })
                .await;
            match answer {
                // One answer per question, or the server would reject the round.
                Some(PromptAnswer::KeyboardInteractive {
                    answers: Some(answers),
                }) if answers.len() == count => Some(answers),
                _ => None,
            }
        })
    }
}
