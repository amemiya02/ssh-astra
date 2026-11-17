//! A remote Terminal: an interactive shell channel with a PTY.

use std::sync::Arc;

use russh::client::Msg;
use russh::{Channel, ChannelMsg};
use tokio::sync::{mpsc, oneshot};

use super::{ConnectError, Connection};
use crate::terminal::{Result, Terminal, TerminalError, TerminalEvent, TerminalSize};

const TERM: &str = "xterm-256color";

enum Command {
    Data(Vec<u8>),
    Resize(TerminalSize),
    Close,
}

/// A shell on a remote Host over a Connection. Implements [`Terminal`], so it
/// lives in the same TerminalRegistry as Local terminals.
pub struct RemoteShell {
    commands: mpsc::UnboundedSender<Command>,
}

pub(super) async fn start<F>(
    connection: Arc<Connection>,
    channel: Channel<Msg>,
    size: TerminalSize,
    mut sink: F,
) -> Result<RemoteShell, ConnectError>
where
    F: FnMut(TerminalEvent) + Send + 'static,
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
        loop {
            let msg = tokio::select! {
                msg = reader.wait() => msg,
                _ = &mut closed_rx => None,
            };
            let Some(msg) = msg else { break };
            match msg {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    sink(TerminalEvent::Output(data.to_vec()))
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        sink(TerminalEvent::Exit { code });
        drop(ended_tx);
    });

    let (commands, mut rx) = mpsc::unbounded_channel();
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

    Ok(RemoteShell { commands })
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
