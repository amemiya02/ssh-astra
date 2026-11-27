use std::{future::Future, time::Duration};

use russh::ChannelMsg;
use tokio::time::{timeout_at, Instant};

use super::Connection;

/// The separate byte streams and exit status from an SSH exec channel.
#[derive(Debug, PartialEq, Eq)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub status: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum ExecError {
    #[error(transparent)]
    Ssh(#[from] russh::Error),
    #[error("the command was ended by signal {0:?}")]
    Signalled(russh::Sig),
    #[error("the SSH channel closed without reporting the command's exit status")]
    MissingExitStatus,
    #[error("the command exceeded the output limit")]
    OutputLimit,
    #[error("the command timed out")]
    TimedOut,
}

impl Connection {
    /// Runs a command without a PTY or stdin on its own channel. The combined
    /// captured output is limited to 1 MiB.
    pub async fn exec(&self, command: &str) -> Result<ExecOutput, ExecError> {
        self.exec_with_limits(command, 1024 * 1024, None).await
    }

    pub(super) async fn exec_bounded(
        &self,
        command: &str,
        output_limit: usize,
        timeout: Duration,
    ) -> Result<ExecOutput, ExecError> {
        self.exec_with_limits(command, output_limit, Some(Instant::now() + timeout))
            .await
    }

    async fn exec_with_limits(
        &self,
        command: &str,
        output_limit: usize,
        deadline: Option<Instant>,
    ) -> Result<ExecOutput, ExecError> {
        let mut channel =
            before_deadline(deadline, async { Ok(self.open_session_channel().await?) }).await?;
        let result = before_deadline(deadline, async {
            channel.exec(true, command).await?;
            channel.eof().await?;

            let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
            let mut status = None;
            let mut signal = None;
            while let Some(message) = channel.wait().await {
                let output_len = stdout.len() + stderr.len();
                let (data, stream) = match message {
                    ChannelMsg::Data { data } => (data, &mut stdout),
                    ChannelMsg::ExtendedData { data, ext: 1 } => (data, &mut stderr),
                    ChannelMsg::Failure => return Err(russh::Error::RequestDenied.into()),
                    ChannelMsg::ExitStatus { exit_status } => {
                        status = Some(exit_status);
                        continue;
                    }
                    ChannelMsg::ExitSignal { signal_name, .. } => {
                        signal = Some(signal_name);
                        continue;
                    }
                    ChannelMsg::Close => break,
                    _ => continue,
                };
                if output_len + data.len() > output_limit {
                    return Err(ExecError::OutputLimit);
                }
                stream.extend_from_slice(&data);
            }
            if let Some(signal) = signal {
                return Err(ExecError::Signalled(signal));
            }
            Ok(ExecOutput {
                stdout,
                stderr,
                status: status.ok_or(ExecError::MissingExitStatus)?,
            })
        })
        .await;
        if result.is_err() {
            let close_deadline = deadline.map(|_| Instant::now() + Duration::from_millis(250));
            let _ = before_deadline(close_deadline, async { Ok(channel.close().await?) }).await;
        }
        result
    }
}

async fn before_deadline<T>(
    deadline: Option<Instant>,
    future: impl Future<Output = Result<T, ExecError>>,
) -> Result<T, ExecError> {
    match deadline {
        Some(deadline) => timeout_at(deadline, future)
            .await
            .map_err(|_| ExecError::TimedOut)?,
        None => future.await,
    }
}

/// Quotes text as exactly one POSIX shell word. The caller still controls
/// how the receiving program distinguishes a filename from an option.
pub fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::shell_quote;

    #[test]
    fn quotes_one_posix_shell_word() {
        for (text, quoted) in [
            ("", "''"),
            ("two words", "'two words'"),
            ("'both\"", r#"''\''both"'"#),
            ("line\nbreak", "'line\nbreak'"),
            ("$HOME `pwd`", "'$HOME `pwd`'"),
            ("-leading", "'-leading'"),
        ] {
            assert_eq!(shell_quote(text), quoted, "literal {text:?}");
        }
    }
}
