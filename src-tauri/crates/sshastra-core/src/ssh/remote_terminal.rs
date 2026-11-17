//! A remote Terminal that outlives its Connection dropping.
//!
//! When the Connection under its shell drops (the server went away, or
//! keepalives went unanswered), the Terminal reports
//! [`ConnectionState::Reconnecting`], connects again after a growing delay
//! (a few times), and on success starts a new shell in the same Terminal and
//! reports [`ConnectionState::Connected`]. The old shell's processes are gone.
//! When every try fails it reports [`ConnectionState::Disconnected`] and waits
//! for [`Terminal::reconnect`].
//!
//! With ShellIntegration on ([`RemoteTerminalOptions::shell_integration`]),
//! every shell it starts, the first and each after a reconnect, gets the
//! prompt hook typed in, and the directories it reports come out as
//! [`TerminalEvent::Cwd`].

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::time::Instant;

use tokio::sync::mpsc;

use super::shell::ShellEvent;
use super::{ConnectError, Connection, RemoteShell};
use crate::terminal::{
    ConnectionState, Result, ShellOutput, Terminal, TerminalError, TerminalEvent, TerminalSize,
    INJECTION,
};

/// How a [`RemoteTerminal`] retries a dropped Connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReconnectPolicy {
    /// Automatic tries before giving up.
    pub attempts: u32,
    /// The wait before the first try; it doubles before each next one.
    pub first_delay: Duration,
}

impl Default for ReconnectPolicy {
    /// Three tries, after 1 s, 2 s and 4 s.
    fn default() -> Self {
        Self {
            attempts: 3,
            first_delay: Duration::from_secs(1),
        }
    }
}

/// How a [`RemoteTerminal`] runs its shells.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RemoteTerminalOptions {
    pub reconnect: ReconnectPolicy,
    /// Type the ShellIntegration hook into each new shell and report its
    /// directory (`terminal::INJECTION`).
    pub shell_integration: bool,
}

enum Command {
    Data(Vec<u8>),
    Resize(TerminalSize),
    Reconnect,
    Close,
}

/// A shell on a remote Host that reconnects when its Connection drops; see
/// the module docs. Its events go to the sink given to [`Self::open`],
/// including [`TerminalEvent::Connection`] changes.
pub struct RemoteTerminal {
    commands: mpsc::UnboundedSender<Command>,
}

impl RemoteTerminal {
    /// Connects with `connect` and starts a shell of `size`, without
    /// ShellIntegration. `connect` is called again for every reconnect; it
    /// returns the Host's shared Connection (e.g. through
    /// `ConnectionManager::connect_through`).
    pub async fn open<C, Fut, F>(
        connect: C,
        policy: ReconnectPolicy,
        size: TerminalSize,
        sink: F,
    ) -> Result<Self, ConnectError>
    where
        C: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Arc<Connection>, ConnectError>> + Send + 'static,
        F: FnMut(TerminalEvent) + Send + 'static,
    {
        let options = RemoteTerminalOptions {
            reconnect: policy,
            shell_integration: false,
        };
        Self::open_with(connect, options, size, sink).await
    }

    /// Like [`open`](Self::open), with every option.
    pub async fn open_with<C, Fut, F>(
        connect: C,
        options: RemoteTerminalOptions,
        size: TerminalSize,
        sink: F,
    ) -> Result<Self, ConnectError>
    where
        C: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Arc<Connection>, ConnectError>> + Send + 'static,
        F: FnMut(TerminalEvent) + Send + 'static,
    {
        let integration = options.shell_integration;
        let (shell_tx, shell_events) = mpsc::unbounded_channel();
        let shell = start_shell(&connect().await?, size, &shell_tx).await?;
        let (commands, command_rx) = mpsc::unbounded_channel();
        let runner = Runner {
            connect: Box::new(move || Box::pin(connect())),
            policy: options.reconnect,
            integration,
            size,
            sink: Box::new(sink),
            commands: command_rx,
            shell_tx,
            shell_events,
        };
        tokio::spawn(runner.run(shell));
        Ok(Self { commands })
    }

    fn send(&self, command: Command) -> Result<()> {
        self.commands
            .send(command)
            .map_err(|_| TerminalError::Io("the remote Terminal has ended".into()))
    }
}

impl Terminal for RemoteTerminal {
    /// Input typed while disconnected is dropped.
    fn write(&mut self, data: &[u8]) -> Result<()> {
        self.send(Command::Data(data.to_vec()))
    }

    fn resize(&mut self, size: TerminalSize) -> Result<()> {
        self.send(Command::Resize(size))
    }

    fn close(&mut self) -> Result<()> {
        let _ = self.send(Command::Close);
        Ok(())
    }

    /// Tries once, right away, when automatic tries are over or still
    /// waiting; does nothing while connected.
    fn reconnect(&mut self) -> Result<()> {
        self.send(Command::Reconnect)
    }
}

type Connect =
    Box<dyn Fn() -> super::BoxFuture<'static, Result<Arc<Connection>, ConnectError>> + Send + Sync>;

async fn start_shell(
    connection: &Arc<Connection>,
    size: TerminalSize,
    events: &mpsc::UnboundedSender<ShellEvent>,
) -> Result<RemoteShell, ConnectError> {
    let events = events.clone();
    connection
        .start_shell(size, move |event| {
            let _ = events.send(event);
        })
        .await
}

/// How long output must pause at what looks like a prompt (not after a
/// newline) before the ShellIntegration hook is typed in.
const PROMPT_QUIET: Duration = Duration::from_millis(150);
/// The longest wait for that prompt; the hook goes in anyway after it.
const PROMPT_WAIT: Duration = Duration::from_secs(5);
/// How long output is hidden waiting for the hook's ready marker.
const READY_TIMEOUT: Duration = Duration::from_secs(3);

/// Typing the ShellIntegration hook into one shell.
enum Hook {
    /// Waiting for the shell's first prompt.
    Waiting(Waiting),
    /// Typed in; output is hidden until the ready marker or this deadline.
    Hiding(Instant),
    /// In, given up, or ShellIntegration is off.
    Done,
}

struct Waiting {
    started: Instant,
    /// When output last arrived, if its last byte was not a newline.
    at_prompt: Option<Instant>,
}

impl Default for Waiting {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            at_prompt: None,
        }
    }
}

impl Waiting {
    fn saw(&mut self, output: &[u8]) {
        if let Some(&last) = output.last() {
            self.at_prompt = (last != b'\n').then(Instant::now);
        }
    }
}

impl Hook {
    fn deadline(&self) -> Option<Instant> {
        match self {
            Hook::Waiting(w) => {
                let latest = w.started + PROMPT_WAIT;
                Some(
                    w.at_prompt
                        .map_or(latest, |at| (at + PROMPT_QUIET).min(latest)),
                )
            }
            Hook::Hiding(until) => Some(*until),
            Hook::Done => None,
        }
    }
}

/// Why waiting ended without a shell.
enum Stop {
    /// The user closed the Terminal.
    Closed,
}

/// The task behind a [`RemoteTerminal`]: forwards its shell's events and
/// replaces the shell when the Connection drops.
struct Runner {
    connect: Connect,
    policy: ReconnectPolicy,
    /// Type the ShellIntegration hook into every new shell.
    integration: bool,
    size: TerminalSize,
    sink: Box<dyn FnMut(TerminalEvent) + Send>,
    commands: mpsc::UnboundedReceiver<Command>,
    /// Every shell this Terminal runs reports here. A shell's last event is
    /// `Exit` or `Lost`, so events of an old shell never follow a new one's.
    shell_tx: mpsc::UnboundedSender<ShellEvent>,
    shell_events: mpsc::UnboundedReceiver<ShellEvent>,
}

impl Runner {
    async fn run(mut self, mut shell: RemoteShell) {
        loop {
            if self.serve(&mut shell).await.is_err() {
                return;
            }
            drop(shell);
            shell = match self.recover().await {
                Ok(shell) => shell,
                Err(Stop::Closed) => return (self.sink)(TerminalEvent::Exit { code: None }),
            };
            (self.sink)(TerminalEvent::Connection(ConnectionState::Connected));
        }
    }

    /// Runs `shell` until its Connection drops (`Ok`) or it ends (`Err`,
    /// after sending `Exit`).
    async fn serve(&mut self, shell: &mut RemoteShell) -> std::result::Result<(), ()> {
        let mut output = ShellOutput::default();
        let mut hook = if self.integration {
            Hook::Waiting(Waiting::default())
        } else {
            Hook::Done
        };
        // Keystrokes typed while the hook goes in, sent after it.
        let mut typed = Vec::new();
        loop {
            let deadline = hook.deadline();
            tokio::select! {
                // Shell events first: output that arrived before a close is shown.
                biased;
                event = self.shell_events.recv() => match event {
                    Some(ShellEvent::Output(bytes)) => {
                        if let Hook::Waiting(waiting) = &mut hook {
                            waiting.saw(&bytes);
                        }
                        // Reports also come from `REPORT_CWD` typed in without the hook.
                        let shown = output.feed(&bytes);
                        self.show(shown.output, shown.cwds);
                        if matches!(hook, Hook::Hiding(_)) && !output.is_hiding() {
                            hook = Hook::Done;
                            let _ = shell.write(&std::mem::take(&mut typed));
                        }
                    }
                    Some(ShellEvent::Exit { code }) => {
                        self.show(output.reveal(), Vec::new());
                        (self.sink)(TerminalEvent::Exit { code });
                        return Err(());
                    }
                    Some(ShellEvent::Lost) => return Ok(()),
                    // Unreachable: `shell_tx` keeps the channel open.
                    None => return Err(()),
                },
                () = tokio::time::sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => {
                    if let Hook::Waiting(_) = hook {
                        let _ = shell.write(INJECTION.as_bytes());
                        output.hide_until_ready();
                        hook = Hook::Hiding(Instant::now() + READY_TIMEOUT);
                    } else {
                        // The shell never printed the marker: show what it did.
                        self.show(output.reveal(), Vec::new());
                        hook = Hook::Done;
                        let _ = shell.write(&std::mem::take(&mut typed));
                    }
                },
                command = self.commands.recv() => match command.unwrap_or(Command::Close) {
                    // Failures mean the shell is ending; its last event follows.
                    Command::Data(bytes) if matches!(hook, Hook::Done) => { let _ = shell.write(&bytes); }
                    Command::Data(bytes) => typed.extend_from_slice(&bytes),
                    Command::Resize(size) => {
                        self.size = size;
                        let _ = shell.resize(size);
                    }
                    Command::Reconnect => {}
                    Command::Close => {
                        let _ = shell.close();
                        (self.sink)(TerminalEvent::Exit { code: None });
                        return Err(());
                    }
                },
            }
        }
    }

    fn show(&mut self, output: Vec<u8>, cwds: Vec<String>) {
        if !output.is_empty() {
            (self.sink)(TerminalEvent::Output(output));
        }
        for cwd in cwds {
            (self.sink)(TerminalEvent::Cwd(cwd));
        }
    }

    /// A new shell on a new Connection: automatic tries with growing delays,
    /// then single tries whenever the user asks.
    async fn recover(&mut self) -> std::result::Result<RemoteShell, Stop> {
        let (mut attempts, mut delay) = (self.policy.attempts.max(1), self.policy.first_delay);
        loop {
            let mut failure = None;
            for attempt in 1..=attempts {
                self.report(ConnectionState::Reconnecting { attempt, attempts });
                self.wait(delay).await?;
                match self.try_connect().await? {
                    Ok(shell) => return Ok(shell),
                    Err(e) => {
                        let retry = is_transient(&e);
                        failure = Some(e);
                        if !retry {
                            break;
                        }
                    }
                }
                delay = delay.saturating_mul(2);
            }
            let reason = failure.map_or_else(String::new, |e| e.to_string());
            self.report(ConnectionState::Disconnected { reason });
            self.wait_for_reconnect().await?;
            (attempts, delay) = (1, Duration::ZERO);
        }
    }

    fn report(&mut self, state: ConnectionState) {
        (self.sink)(TerminalEvent::Connection(state));
    }

    /// Handles a command while there is no shell. `true` means try now.
    fn idle(&mut self, command: Option<Command>) -> std::result::Result<bool, Stop> {
        match command.unwrap_or(Command::Close) {
            Command::Close => Err(Stop::Closed),
            Command::Reconnect => Ok(true),
            Command::Resize(size) => {
                self.size = size;
                Ok(false)
            }
            Command::Data(_) => Ok(false),
        }
    }

    /// Waits `delay`, or less if the user asks to reconnect now.
    async fn wait(&mut self, delay: Duration) -> std::result::Result<(), Stop> {
        let sleep = tokio::time::sleep(delay);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                () = &mut sleep => return Ok(()),
                command = self.commands.recv() => if self.idle(command)? {
                    return Ok(());
                },
            }
        }
    }

    async fn wait_for_reconnect(&mut self) -> std::result::Result<(), Stop> {
        loop {
            let command = self.commands.recv().await;
            if self.idle(command)? {
                return Ok(());
            }
        }
    }

    /// One connect and shell start, which the user can cut short by closing.
    async fn try_connect(
        &mut self,
    ) -> std::result::Result<Result<RemoteShell, ConnectError>, Stop> {
        let connecting = (self.connect)();
        tokio::pin!(connecting);
        let connection = loop {
            tokio::select! {
                result = &mut connecting => match result {
                    Ok(connection) => break connection,
                    Err(e) => return Ok(Err(e)),
                },
                command = self.commands.recv() => {
                    self.idle(command)?;
                }
            }
        };
        // The size may have changed while connecting.
        Ok(start_shell(&connection, self.size, &self.shell_tx).await)
    }
}

/// Whether trying again may help: network trouble, not a refusal by the
/// server or the user.
fn is_transient(error: &ConnectError) -> bool {
    match error {
        ConnectError::Unreachable(_) | ConnectError::TimedOut | ConnectError::Protocol(_) => true,
        ConnectError::JumpHost { source, .. } => is_transient(source),
        _ => false,
    }
}
