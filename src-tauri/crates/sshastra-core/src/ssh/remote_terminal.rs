//! A remote Terminal that outlives its Connection dropping.
//!
//! When the Connection under its shell drops (the server went away, or
//! keepalives went unanswered), the Terminal reports
//! [`ConnectionState::Reconnecting`], connects again after a growing delay
//! (a few times), and on success starts a new shell in the same Terminal and
//! reports [`ConnectionState::Connected`]. The old shell's processes are gone.
//! When every try fails it reports [`ConnectionState::Disconnected`] and waits
//! for a manual retry or, after a transient failure, a focus or wake event.
//!
//! With ShellIntegration on ([`RemoteTerminalOptions::shell_integration`]),
//! every shell it starts, the first and each after a reconnect, gets the
//! prompt hook typed in. It reports the current directory and shell markers.
//! The configured post-login command runs in each new shell after startup.
//! A split Terminal also changes to its inherited directory in its first shell.
//! After a reconnect the new shell restores the last reported directory.

use std::fmt::Write as _;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use tokio::time::Instant;

use tokio::sync::{mpsc, oneshot, watch};

use super::progress::HopProgress;
use super::shell::ShellEvent;
use super::{
    shell_quote, BoxFuture, ConnectError, ConnectStage, Connection, Prompter, RemoteShell,
};
use crate::hosts::Host;
use crate::terminal::{
    ConnectionState, IdlePrompt, OutputDecoder, Result, ShellIntegrationEvent,
    ShellIntegrationStatus, ShellOutput, Terminal, TerminalBackspace, TerminalCharset,
    TerminalError, TerminalEvent, TerminalSize, INJECTION,
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
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RemoteTerminalOptions {
    pub reconnect: ReconnectPolicy,
    /// Type the ShellIntegration hook into each new shell and report its
    /// directory (`terminal::INJECTION`).
    pub shell_integration: bool,
    /// Command typed once into every new shell after startup.
    pub post_login_command: Option<String>,
    /// Working directory inherited when a new Terminal is split from another.
    pub initial_cwd: Option<String>,
    /// Character set for the shell's input and output.
    pub charset: TerminalCharset,
    /// Byte sent for the Backspace key.
    pub backspace: TerminalBackspace,
}

impl RemoteTerminalOptions {
    pub fn for_host(host: &Host, shell_integration: bool) -> Self {
        Self {
            shell_integration,
            post_login_command: host.post_login_command.clone(),
            charset: host.terminal_charset.unwrap_or_default(),
            backspace: host.terminal_backspace.unwrap_or_default(),
            ..Self::default()
        }
    }
}

enum Command {
    Data(Vec<u8>),
    ConnectionData { generation: u64, input: Vec<u8> },
    FollowDirectory { prompt_id: u64, input: Vec<u8> },
    ObserveIdlePrompt(oneshot::Sender<IdlePrompt>),
    Resize(TerminalSize),
    Reconnect,
    Close,
}

/// A shell on a remote Host that reconnects when its Connection drops; see
/// the module docs. Its events go to the sink given to [`Self::open`],
/// including [`TerminalEvent::Connection`] changes.
pub struct RemoteTerminal {
    commands: mpsc::UnboundedSender<Command>,
    retry_on_focus_or_wake: watch::Sender<bool>,
    connection: watch::Receiver<Option<(u64, Weak<Connection>)>>,
    charset: TerminalCharset,
    backspace: TerminalBackspace,
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
            ..RemoteTerminalOptions::default()
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
        Self::open_inner(connect, options, size, sink, None).await
    }

    /// Like [`open_with`](Self::open_with), reporting progress when opening
    /// the initial shell and each replacement shell. The `connect` callback
    /// reports the Connection steps.
    pub async fn open_with_progress<C, Fut, F>(
        connect: C,
        options: RemoteTerminalOptions,
        size: TerminalSize,
        sink: F,
        host: Host,
        prompter: Arc<dyn Prompter>,
    ) -> Result<Self, ConnectError>
    where
        C: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Arc<Connection>, ConnectError>> + Send + 'static,
        F: FnMut(TerminalEvent) + Send + 'static,
    {
        Self::open_inner(connect, options, size, sink, Some((host, prompter))).await
    }

    async fn open_inner<C, Fut, F>(
        connect: C,
        options: RemoteTerminalOptions,
        size: TerminalSize,
        sink: F,
        progress: Option<ShellProgress>,
    ) -> Result<Self, ConnectError>
    where
        C: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Arc<Connection>, ConnectError>> + Send + 'static,
        F: FnMut(TerminalEvent) + Send + 'static,
    {
        let post_login = options
            .post_login_command
            .filter(|command| !command.trim().is_empty());
        let split_startup_input = options
            .initial_cwd
            .as_deref()
            .and_then(|cwd| split_startup_command(cwd, post_login.as_deref()))
            .map(|command| startup_line(options.charset, &command));
        let (shell_tx, shell_events) = mpsc::unbounded_channel();
        let connection = connect().await?;
        let shell = start_shell(&connection, size, &shell_tx, progress.as_ref()).await?;
        let (commands, command_rx) = mpsc::unbounded_channel();
        let retry_on_focus_or_wake = watch::Sender::new(false);
        let (active_connection, connection) =
            watch::channel(Some((0, Arc::downgrade(&connection))));
        let runner = Runner {
            connect: Box::new(move || Box::pin(connect())),
            progress,
            policy: options.reconnect,
            integration: options.shell_integration,
            charset: options.charset,
            post_login,
            split_startup_input,
            prompt_id: 0,
            size,
            sink: Box::new(sink),
            commands: command_rx,
            retry_on_focus_or_wake: retry_on_focus_or_wake.clone(),
            active_connection,
            idle_prompt: watch::Sender::new(None),
            generation: 0,
            shell_tx,
            shell_events,
        };
        tokio::spawn(runner.run(shell));
        Ok(Self {
            commands,
            retry_on_focus_or_wake,
            connection,
            charset: options.charset,
            backspace: options.backspace,
        })
    }

    fn send(&self, command: Command) -> Result<()> {
        self.commands
            .send(command)
            .map_err(|_| TerminalError::Io("the remote Terminal has ended".into()))
    }
}

const MAX_PTY_LINE: usize = 4096;

fn startup_line(charset: TerminalCharset, command: &str) -> Vec<u8> {
    let mut line = charset.encode_input(command.as_bytes());
    line.push(b'\r');
    line
}

fn encode_shell_directory(cwd: &str) -> Option<(&'static str, String)> {
    if !cwd.starts_with('/') || cwd.contains('\0') {
        return None;
    }

    // Keep special bytes out of both PTY input and shell syntax.
    let mut encoded = String::with_capacity(cwd.len());
    for byte in cwd.bytes() {
        if byte.is_ascii_alphanumeric() || b"/._-".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            write!(encoded, "\\0{byte:03o}").expect("writing to a String succeeds");
        }
    }
    // Command substitution trims trailing newlines. A directory can be addressed via its ".".
    let format = if cwd.ends_with('\n') { "%b/." } else { "%b" };
    Some((format, shell_quote(&encoded)))
}

fn split_startup_command(cwd: &str, post_login: Option<&str>) -> Option<String> {
    let (format, directory) = encode_shell_directory(cwd)?;
    // Escaping the command names bypasses aliases and lets zsh use its built-ins.
    let cd = format!(r#"\cd -- "$(\printf '{format}' {directory})""#);
    Some(with_post_login(&cd, post_login))
}

fn with_post_login(cd: &str, post_login: Option<&str>) -> String {
    match post_login {
        None => format!(" {cd}"),
        Some(login) => {
            // Keep cd in the evaluated shell line so a foreground login command cannot read
            // it as input. Quote the login script as written and preserve its exit status.
            let after_login = shell_quote(&format!("{cd}; (exit "));
            format!("eval {}; eval {after_login}\"$?\"')'", shell_quote(login))
        }
    }
}

fn builtin_shell_cd(path: &str) -> Option<String> {
    if path.len() >= MAX_PTY_LINE {
        return None;
    }
    let (format, directory) = encode_shell_directory(path)?;
    // Use the shell's built-ins in case an alias or function overrides cd or printf.
    Some(format!(
        r#"\builtin cd -- "$(\builtin printf '{format}' {directory})""#
    ))
}

fn restore_directory_input(
    path: &str,
    post_login: Option<&str>,
    charset: TerminalCharset,
) -> Option<Vec<u8>> {
    let cd = builtin_shell_cd(path)?;
    let cd = format!(r#"{cd} >/dev/null 2>&1 || \builtin cd -- "$HOME" >/dev/null 2>&1"#);
    let input = startup_line(charset, &with_post_login(&cd, post_login));
    (input.len() <= MAX_PTY_LINE).then_some(input)
}

fn follow_directory_input(path: &str) -> Option<Vec<u8>> {
    let cd = builtin_shell_cd(path)?;
    let input = format!(" {cd}\r").into_bytes();
    (input.len() <= MAX_PTY_LINE).then_some(input)
}

impl Terminal for RemoteTerminal {
    /// Input typed while disconnected is dropped.
    fn write(&mut self, data: &[u8]) -> Result<()> {
        // xterm sends a Backspace key as its own event, optionally with ESC
        // for Alt. Embedded DEL bytes in pasted text retain their value.
        let data: &[u8] = match (self.backspace, data) {
            (TerminalBackspace::CtrlH, b"\x7f") => b"\x08",
            (TerminalBackspace::CtrlH, b"\x1b\x7f") => b"\x1b\x08",
            _ => data,
        };
        self.send(Command::Data(self.charset.encode_input(data)))
    }

    fn connection(&self) -> Option<(u64, Arc<Connection>)> {
        let connection = self.connection.borrow();
        let (generation, connection) = connection.as_ref()?;
        let connection = connection
            .upgrade()
            .filter(|connection| !connection.is_closed())?;
        Some((*generation, connection))
    }

    fn observe_idle_prompt(&self) -> BoxFuture<'static, Option<IdlePrompt>> {
        let (reply, observation) = oneshot::channel();
        let sent = self.send(Command::ObserveIdlePrompt(reply)).is_ok();
        Box::pin(async move {
            if !sent {
                return None;
            }
            observation.await.ok()
        })
    }

    fn write_for_connection(&mut self, generation: u64, data: &[u8]) -> Result<()> {
        self.send(Command::ConnectionData {
            generation,
            input: self.charset.encode_input(data),
        })
    }

    fn follow_file_directory(&mut self, prompt_id: u64, path: &str) -> Result<()> {
        if let Some(input) = follow_directory_input(path) {
            self.send(Command::FollowDirectory { prompt_id, input })?;
        }
        Ok(())
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

    fn reconnect_disconnected(&mut self) {
        // Claim the idle retry once. A focus or wake during backoff or a connect
        // leaves no request queued for a later failure.
        self.retry_on_focus_or_wake.send_if_modified(std::mem::take);
    }
}

type Connect =
    Box<dyn Fn() -> super::BoxFuture<'static, Result<Arc<Connection>, ConnectError>> + Send + Sync>;
type ShellProgress = (Host, Arc<dyn Prompter>);

async fn start_shell(
    connection: &Arc<Connection>,
    size: TerminalSize,
    events: &mpsc::UnboundedSender<ShellEvent>,
    progress: Option<&ShellProgress>,
) -> Result<RemoteShell, ConnectError> {
    let step = progress.map(|(host, prompter)| {
        HopProgress {
            host,
            jump_host: false,
            prompter: prompter.as_ref(),
        }
        .start(ConnectStage::Shell)
    });
    let events = events.clone();
    let shell = connection
        .start_shell(size, move |event| {
            let _ = events.send(event);
        })
        .await;
    match step {
        Some(step) => step.finish(shell),
        None => shell,
    }
}

/// How long output must pause at what looks like a prompt (not after a
/// newline) before sending startup input.
const PROMPT_QUIET: Duration = Duration::from_millis(150);
/// The longest wait for that prompt before sending startup input.
const PROMPT_WAIT: Duration = Duration::from_secs(5);
/// How long output is hidden waiting for the hook's ready marker.
const READY_TIMEOUT: Duration = Duration::from_secs(3);

/// Startup of one shell, including its optional ShellIntegration hook.
enum Startup {
    /// Waiting for the shell's first prompt.
    Waiting(Waiting),
    /// The hook is typed in; output is hidden until its ready marker or this deadline.
    InstallingHook(Instant),
    /// Startup input has been sent, or none was configured.
    Ready,
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

impl Startup {
    fn deadline(&self) -> Option<Instant> {
        match self {
            Startup::Waiting(w) => {
                let latest = w.started + PROMPT_WAIT;
                Some(
                    w.at_prompt
                        .map_or(latest, |at| (at + PROMPT_QUIET).min(latest)),
                )
            }
            Startup::InstallingHook(until) => Some(*until),
            Startup::Ready => None,
        }
    }
}

/// Why waiting ended without a shell.
enum Stop {
    /// The user closed the Terminal.
    Closed,
}

enum ReconnectError {
    Connection(ConnectError),
    Shell(ConnectError),
}

/// Checks that input from the webview still targets the idle prompt it observed.
#[derive(Default)]
struct FollowPrompt {
    idle: Option<u64>,
    at_prompt: bool,
    queued_input: bool,
}

impl FollowPrompt {
    fn marker(&mut self, event: &ShellIntegrationEvent, startup_complete: bool) {
        if let ShellIntegrationEvent::PromptStart { prompt_id } = event {
            self.at_prompt = true;
            self.idle = (startup_complete && !self.queued_input).then_some(*prompt_id);
        } else {
            self.at_prompt = false;
            self.idle = None;
        }
    }

    fn input(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.idle = None;
        if !self.at_prompt {
            self.queued_input = true;
            return;
        }
        let submission = bytes
            .iter()
            .position(|&b| matches!(b, b'\r' | b'\n' | b'\x03'));
        self.queued_input = bytes != b"\x03"
            && (self.queued_input || submission.is_some_and(|index| index < bytes.len() - 1));
        self.at_prompt = submission.is_none();
    }

    fn take(&mut self, prompt_id: u64) -> bool {
        if self.idle != Some(prompt_id) {
            return false;
        }
        self.at_prompt = false;
        self.idle = None;
        true
    }
}

/// The task behind a [`RemoteTerminal`]: forwards its shell's events and
/// replaces the shell when the Connection drops.
struct Runner {
    connect: Connect,
    progress: Option<ShellProgress>,
    policy: ReconnectPolicy,
    /// Type the ShellIntegration hook into every new shell.
    integration: bool,
    charset: TerminalCharset,
    post_login: Option<String>,
    split_startup_input: Option<Vec<u8>>,
    prompt_id: u64,
    size: TerminalSize,
    sink: Box<dyn FnMut(TerminalEvent) + Send>,
    commands: mpsc::UnboundedReceiver<Command>,
    retry_on_focus_or_wake: watch::Sender<bool>,
    active_connection: watch::Sender<Option<(u64, Weak<Connection>)>>,
    idle_prompt: watch::Sender<Option<u64>>,
    generation: u64,
    /// Every shell this Terminal runs reports here. A shell's last event is
    /// `Exit` or `Lost`, so events of an old shell never follow a new one's.
    shell_tx: mpsc::UnboundedSender<ShellEvent>,
    shell_events: mpsc::UnboundedReceiver<ShellEvent>,
}

impl Runner {
    async fn run(mut self, mut shell: RemoteShell) {
        let mut cwd = None;
        loop {
            let ended = self.serve(&mut shell, cwd).await;
            self.idle_prompt.send_replace(None);
            self.active_connection.send_replace(None);
            let Ok(last_cwd) = ended else {
                return;
            };
            cwd = last_cwd;
            log::warn!("remote Terminal Connection lost");
            let reported = Arc::clone(&shell.reconnect_failure_reported);
            drop(shell);
            shell = match self.recover(&reported).await {
                Ok(shell) => shell,
                Err(Stop::Closed) => return (self.sink)(TerminalEvent::Exit { code: None }),
            };
            (self.sink)(TerminalEvent::Connection(ConnectionState::Connected));
        }
    }

    /// Runs `shell` until its Connection drops (`Ok` with its last reported
    /// directory) or it ends (`Err`,
    /// after sending `Exit`).
    async fn serve(
        &mut self,
        shell: &mut RemoteShell,
        mut cwd: Option<String>,
    ) -> std::result::Result<Option<String>, ()> {
        let mut output = ShellOutput::new(self.charset, self.prompt_id);
        let mut decoder = OutputDecoder::new(self.charset);
        let post_login = self.post_login.as_deref();
        let restore = cwd
            .as_deref()
            .and_then(|path| restore_directory_input(path, post_login, self.charset));
        let post_login = post_login.map(|command| startup_line(self.charset, command));
        if !self.integration {
            self.report_integration(ShellIntegrationStatus::Disabled);
        }
        let mut startup =
            if self.integration || post_login.is_some() || self.split_startup_input.is_some() {
                Startup::Waiting(Waiting::default())
            } else {
                Startup::Ready
            };
        // User input waits until startup input has been sent.
        let mut typed = Vec::new();
        let mut integrated = false;
        let mut restoring = restore.is_some();
        let mut startup_command_pending = false;
        let mut follow_prompt = FollowPrompt::default();
        loop {
            let deadline = startup.deadline();
            tokio::select! {
                // Shell events first: output that arrived before a close is shown.
                biased;
                event = self.shell_events.recv() => match event {
                    Some(ShellEvent::Output(bytes)) => {
                        if let Startup::Waiting(waiting) = &mut startup {
                            waiting.saw(&bytes);
                        }
                        // Reports also come from `REPORT_CWD` typed in without the hook.
                        let shown = output.feed(&bytes);
                        if !shown.output.is_empty() {
                            self.show(decoder.decode(shown.output, false));
                        }
                        let installing = matches!(startup, Startup::InstallingHook(_));
                        if installing {
                            startup_command_pending = self.split_startup_input.is_some()
                                || restore.is_some()
                                || post_login.is_some()
                                || !typed.is_empty();
                        }
                        for event in shown.events {
                            if let TerminalEvent::ShellIntegration(marker) = &event {
                                match marker {
                                    ShellIntegrationEvent::Availability { status } => {
                                        integrated = *status == ShellIntegrationStatus::Available;
                                    }
                                    ShellIntegrationEvent::PromptStart { prompt_id } => {
                                        self.prompt_id = *prompt_id;
                                    }
                                    ShellIntegrationEvent::CommandStart { .. } => {
                                        startup_command_pending = false;
                                    }
                                    ShellIntegrationEvent::CommandEnd { .. } if matches!(startup, Startup::Ready) => {
                                        restoring = false;
                                    }
                                    _ => {}
                                }
                                follow_prompt.marker(marker, !startup_command_pending);
                                self.report_idle_prompt(follow_prompt.idle);
                            }
                            if let TerminalEvent::Cwd(path) = &event {
                                if integrated && !restoring {
                                    cwd = Some(path.clone());
                                }
                            }
                            (self.sink)(event);
                        }
                        if installing && !output.is_hiding() {
                            let restore = restore.as_deref().filter(|_| integrated);
                            self.finish_startup(shell, restore.or(post_login.as_deref()), std::mem::take(&mut typed));
                            startup = Startup::Ready;
                        }
                    }
                    Some(ShellEvent::Exit { code }) => {
                        self.show(decoder.decode(output.reveal(), true));
                        (self.sink)(TerminalEvent::Exit { code });
                        return Err(());
                    }
                    Some(ShellEvent::Lost) => {
                        self.show(decoder.decode(Vec::new(), true));
                        return Ok(cwd);
                    }
                    // Unreachable: `shell_tx` keeps the channel open.
                    None => return Err(()),
                },
                () = tokio::time::sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => {
                    if matches!(startup, Startup::Waiting(_)) && self.integration {
                        let _ = shell.write(INJECTION.as_bytes());
                        output.hide_until_ready();
                        startup = Startup::InstallingHook(Instant::now() + READY_TIMEOUT);
                    } else {
                        if matches!(startup, Startup::InstallingHook(_)) {
                            // The shell never printed the marker: show what it did.
                            self.show(decoder.decode(output.reveal(), false));
                            self.report_integration(ShellIntegrationStatus::TimedOut);
                        }
                        self.finish_startup(shell, post_login.as_deref(), std::mem::take(&mut typed));
                        startup = Startup::Ready;
                    }
                },
                command = self.commands.recv() => match command.unwrap_or(Command::Close) {
                    // Failures mean the shell is ending; its last event follows.
                    Command::Data(bytes) => {
                        follow_prompt.input(&bytes);
                        self.report_idle_prompt(follow_prompt.idle);
                        if matches!(startup, Startup::Ready) {
                            let _ = shell.write(&bytes);
                        } else {
                            typed.extend_from_slice(&bytes);
                        }
                    }
                    Command::ConnectionData { generation, input } => {
                        if self.generation == generation {
                            follow_prompt.input(&input);
                            self.report_idle_prompt(follow_prompt.idle);
                            if matches!(startup, Startup::Ready) {
                                let _ = shell.write(&input);
                            } else {
                                typed.extend_from_slice(&input);
                            }
                        }
                    }
                    Command::FollowDirectory { prompt_id, input } => {
                        // Bind the request to this exact prompt and never buffer it during startup or recovery.
                        if matches!(startup, Startup::Ready) && follow_prompt.take(prompt_id) {
                            self.report_idle_prompt(follow_prompt.idle);
                            let _ = shell.write(&input);
                        }
                    }
                    Command::ObserveIdlePrompt(reply) => {
                        let _ = reply.send(self.idle_prompt.subscribe());
                    }
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

    fn report_idle_prompt(&self, prompt: Option<u64>) {
        self.idle_prompt.send_if_modified(|current| {
            let changed = *current != prompt;
            *current = prompt;
            changed
        });
    }

    fn finish_startup(&mut self, shell: &mut RemoteShell, input: Option<&[u8]>, typed: Vec<u8>) {
        if let Some(line) = self.split_startup_input.as_deref().or(input) {
            if shell.write(line).is_ok() {
                self.split_startup_input = None;
            }
        }
        if !typed.is_empty() {
            let _ = shell.write(&typed);
        }
    }

    fn show(&mut self, output: Vec<u8>) {
        if !output.is_empty() {
            (self.sink)(TerminalEvent::Output(output));
        }
    }

    fn report_integration(&mut self, status: ShellIntegrationStatus) {
        (self.sink)(TerminalEvent::ShellIntegration(
            ShellIntegrationEvent::Availability { status },
        ));
    }

    /// A new shell on a new Connection: automatic tries with growing delays,
    /// then single tries on request.
    async fn recover(&mut self, reported: &AtomicBool) -> std::result::Result<RemoteShell, Stop> {
        let (mut attempts, mut delay) = (self.policy.attempts.max(1), self.policy.first_delay);
        loop {
            let mut failure = None;
            for attempt in 1..=attempts {
                log::info!("remote Terminal reconnect attempt={attempt} maxAttempts={attempts}");
                self.report(ConnectionState::Reconnecting { attempt, attempts });
                self.wait(delay).await?;
                match self.try_connect().await? {
                    Ok(shell) => {
                        log::info!("remote Terminal reconnect result=success");
                        return Ok(shell);
                    }
                    Err(failure_kind) => {
                        let (e, connection_failed) = match failure_kind {
                            ReconnectError::Connection(e) => (e, true),
                            ReconnectError::Shell(e) => (e, false),
                        };
                        log::warn!("remote Terminal reconnect result={}", e.log_kind());
                        let retry = is_transient(&e);
                        failure = Some((e, connection_failed));
                        if !retry {
                            break;
                        }
                    }
                }
                delay = delay.saturating_mul(2);
            }
            let (reason, connection_failed, eligible) = failure.map_or_else(
                || (String::new(), false, false),
                |(e, connection_failed)| (e.to_string(), connection_failed, is_transient(&e)),
            );
            let report_reconnect_failure =
                connection_failed && !reported.swap(true, Ordering::Relaxed);
            self.retry_on_focus_or_wake.send_replace(eligible);
            self.report(ConnectionState::Disconnected {
                reason,
                report_reconnect_failure,
            });
            self.wait_for_reconnect(eligible).await?;
            self.retry_on_focus_or_wake.send_replace(false);
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
            Command::Data(_)
            | Command::ConnectionData { .. }
            | Command::FollowDirectory { .. }
            | Command::ObserveIdlePrompt(_) => Ok(false),
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

    async fn wait_for_reconnect(&mut self, eligible: bool) -> std::result::Result<(), Stop> {
        let mut retry = self.retry_on_focus_or_wake.subscribe();
        loop {
            tokio::select! {
                biased;
                command = self.commands.recv() => if self.idle(command)? {
                    return Ok(());
                },
                _ = retry.wait_for(|allowed| !allowed), if eligible => return Ok(()),
            }
        }
    }

    /// One connect and shell start, which the user can cut short by closing.
    async fn try_connect(
        &mut self,
    ) -> std::result::Result<Result<RemoteShell, ReconnectError>, Stop> {
        let connecting = (self.connect)();
        tokio::pin!(connecting);
        let connection = loop {
            tokio::select! {
                result = &mut connecting => match result {
                    Ok(connection) => break connection,
                    Err(e) => return Ok(Err(ReconnectError::Connection(e))),
                },
                command = self.commands.recv() => {
                    self.idle(command)?;
                }
            }
        };
        // The size may have changed while connecting.
        let shell = start_shell(
            &connection,
            self.size,
            &self.shell_tx,
            self.progress.as_ref(),
        )
        .await
        .map_err(ReconnectError::Shell);
        if shell.is_ok() {
            self.generation += 1;
            self.active_connection
                .send_replace(Some((self.generation, Arc::downgrade(&connection))));
        }
        Ok(shell)
    }
}

/// Whether trying again may help: network trouble, not a refusal by the
/// server or the user.
fn is_transient(error: &ConnectError) -> bool {
    match error {
        ConnectError::Unreachable(_) | ConnectError::TimedOut | ConnectError::Protocol(_) => true,
        ConnectError::Proxy(super::ProxyError::Unreachable | super::ProxyError::TimedOut) => true,
        ConnectError::JumpHost { source, .. } => is_transient(source),
        _ => false,
    }
}
