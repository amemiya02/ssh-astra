//! OpenSSH agent forwarding. Incoming agent channels identify the SSH
//! transport, so authorization is shared by its shells and channel handler.

use std::sync::OnceLock;

use russh::client::{ChannelOpenHandle, Msg};
use russh::keys::{agent::AgentSessionBinding, Error as AgentError};
use russh::{Channel, ChannelMsg, ChannelOpenFailure};

use super::{Agent, CONNECT_TIMEOUT};

pub(super) struct AgentForwarding {
    agent: Agent,
    // Initialized when a shell's forwarding request succeeds. Some SSH
    // key exchanges do not provide an OpenSSH session binding.
    binding: OnceLock<Option<AgentSessionBinding>>,
}

impl AgentForwarding {
    pub(super) fn new(agent: Agent) -> Self {
        Self {
            agent,
            binding: OnceLock::new(),
        }
    }

    pub(super) async fn request(
        &self,
        channel: &mut Channel<Msg>,
        binding: Option<&AgentSessionBinding>,
    ) -> Result<(), russh::Error> {
        channel.agent_forward(true).await?;
        // Wait before requesting the shell, so the first command can use the
        // agent. A refusal or missing reply leaves the shell usable.
        let reply = async {
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Success => return Ok(true),
                    ChannelMsg::Failure => return Ok(false),
                    ChannelMsg::Close | ChannelMsg::Eof => break,
                    _ => {}
                }
            }
            Err(russh::Error::Disconnect)
        };
        if let Ok(accepted) = tokio::time::timeout(CONNECT_TIMEOUT, reply).await {
            if accepted? {
                self.binding.get_or_init(|| binding.cloned());
            }
        }
        Ok(())
    }

    pub(super) async fn open(&self, channel: Channel<Msg>, reply: ChannelOpenHandle) {
        let Some(binding) = self.binding.get().cloned() else {
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return;
        };
        let agent = self.agent.clone();
        // The SSH event loop must stay free to deliver data to the bridge.
        tokio::spawn(async move {
            let connect = async {
                let mut local = agent.connect().await?;
                if let Some(binding) = &binding {
                    // Older agents can decline the extension and still handle
                    // ordinary forwarding. I/O and framing failures close this channel.
                    match local.bind_session(binding, true).await {
                        Ok(()) | Err(AgentError::AgentFailure) => {}
                        Err(_) => return None,
                    }
                }
                Some(local.into_inner())
            };
            let Ok(Some(mut local)) = tokio::time::timeout(CONNECT_TIMEOUT, connect).await else {
                reply.reject(ChannelOpenFailure::ConnectFailed).await;
                return;
            };
            reply.accept().await;
            let _ = tokio::io::copy_bidirectional(&mut channel.into_stream(), &mut local).await;
        });
    }
}
