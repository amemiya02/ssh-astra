//! A remote Terminal: an interactive shell channel with a PTY.

use std::sync::{atomic::AtomicBool, Arc};

use russh::client::Msg;
use russh::{Channel, ChannelMsg};
use tokio::sync::{mpsc, oneshot};

use super::{ConnectError, Connection};
use crate::terminal::{Result, Terminal, TerminalError, TerminalSize};

const TERM: &str = "xterm-256color";

enum Command {
    Data(Vec<u8>),
    Resize(TerminalSize),
    Close,
}

/// What a [`RemoteShell`] reports. `Exit` or `Lost` comes last.
#[derive(Debug)]
pub(super) enum ShellEvent {
    Output(Vec<u8>),
    /// The shell ended (or was closed).
    Exit {
        code: Option<u32>,
    },
    /// The Connection under it dropped: the shell is gone without a word.
    Lost,
}

/// A shell on a remote Host over a Connection. Implements [`Terminal`], so it
/// lives in the same TerminalRegistry as Local terminals.
pub struct RemoteShell {
    commands: mpsc::UnboundedSender<Command>,
    pub(super) reconnect_failure_reported: Arc<AtomicBool>,
}

pub(super) async fn start<F>(
    connection: Arc<Connection>,
    channel: Channel<Msg>,
    size: TerminalSize,
    mut sink: F,
) -> Result<RemoteShell, ConnectError>
where
    F: FnMut(ShellEvent) + Send + 'static,
{
    channel
        .request_pty(false, TERM, size.cols.into(), size.rows.into(), 0, 0, &[])
        .await?;
    channel.request_shell(false).await?;
    let (mut reader, writer) = channel.split();
    let (ended_tx, mut ended_rx) = oneshot::channel::<()>();
    // russh drops the server's reply to a close we started, so the writer
    // tells the reader directly when it closed the channel.
    let (closed_tx, mut closed_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        let mut code = None;
        let lost = loop {
            let msg = tokio::select! {
                msg = reader.wait() => msg,
                _ = &mut closed_rx => break false,
            };
            // The channel's messages stop without a Close only when the
            // whole Connection is gone.
            let Some(msg) = msg else { break true };
            match msg {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    sink(ShellEvent::Output(data.to_vec()))
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Close => break false,
                _ => {}
            }
        };
        // An exit status that made it through is the shell's own ending.
        sink(if lost && code.is_none() {
            ShellEvent::Lost
        } else {
            ShellEvent::Exit { code }
        });
        drop(ended_tx);
    });

    let (commands, mut rx) = mpsc::unbounded_channel();
    let reconnect_failure_reported = Arc::clone(&connection.reconnect_failure_reported);
    tokio::spawn(async move {
        // Holding the Connection keeps it open as long as this shell is.
        let _connection = connection;
        let _closed_tx = closed_tx;
        loop {
            let command = tokio::select! {
                command = rx.recv() => command.unwrap_or(Command::Close),
                _ = &mut ended_rx => break,
            };
            // Failures mean the channel is gone; the reader reports the exit.
            let sent = match command {
                Command::Data(bytes) => writer.data_bytes(bytes).await,
                Command::Resize(size) => {
                    writer
                        .window_change(size.cols.into(), size.rows.into(), 0, 0)
                        .await
                }
                Command::Close => {
                    let _ = writer.close().await;
                    break;
                }
            };
            if sent.is_err() {
                break;
            }
        }
    });

    Ok(RemoteShell {
        commands,
        reconnect_failure_reported,
    })
}

impl RemoteShell {
    fn send(&self, command: Command) -> Result<()> {
        self.commands
            .send(command)
            .map_err(|_| TerminalError::Io("the remote shell has ended".into()))
    }
}

impl Terminal for RemoteShell {
    fn write(&mut self, data: &[u8]) -> Result<()> {
        self.send(Command::Data(data.to_vec()))
    }

    fn resize(&mut self, size: TerminalSize) -> Result<()> {
        self.send(Command::Resize(size))
    }

    fn close(&mut self) -> Result<()> {
        // Already ended is fine: the Exit event has been (or will be) sent.
        let _ = self.send(Command::Close);
        Ok(())
    }
}
