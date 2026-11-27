//! ShellIntegration against real bash and zsh shells in Docker: a remote
//! Terminal reports its shell's directory after `cd`, the injected hook is
//! never shown, and with ShellIntegration off nothing is typed into the shell.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use sshastra_core::hosts::{Host, HostAuth, HostId};
use sshastra_core::known_hosts::KnownHosts;
use sshastra_core::ssh::{
    BoxFuture, ConnectionManager, HostKeyPrompt, PasswordPrompt, Prompter, RemoteTerminal,
    RemoteTerminalOptions, Secret,
};
use sshastra_core::terminal::{
    ConnectionState, ShellIntegrationEvent, ShellIntegrationStatus, Terminal, TerminalEvent,
    TerminalSize, REPORT_CWD,
};
use support::{Service, Sshd};
use tokio::sync::mpsc;

const SIZE: TerminalSize = TerminalSize {
    cols: 100,
    rows: 30,
};

struct TrustingPrompter;

impl Prompter for TrustingPrompter {
    fn confirm_host_key(&self, _: HostKeyPrompt) -> BoxFuture<'_, bool> {
        Box::pin(async { true })
    }

    fn password(&self, _: PasswordPrompt) -> BoxFuture<'_, Option<Secret>> {
        Box::pin(async { Some(Secret::new(support::PASSWORD)) })
    }
}

/// A remote Terminal plus everything it sent, rendered on a virtual screen.
struct Shell {
    terminal: RemoteTerminal,
    rx: mpsc::UnboundedReceiver<TerminalEvent>,
    screen: vt100::Parser,
    output: Vec<u8>,
    integration: Vec<ShellIntegrationEvent>,
    connection: Option<ConnectionState>,
    _known_hosts: tempfile::TempDir,
}

impl Shell {
    async fn open(sshd: &Sshd, user: &str, shell_integration: bool) -> Self {
        Self::open_with_command(sshd, user, shell_integration, None).await
    }

    async fn open_with_command(
        sshd: &Sshd,
        user: &str,
        shell_integration: bool,
        post_login_command: Option<&str>,
    ) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let manager = Arc::new(ConnectionManager::new(KnownHosts::new(
            dir.path().join("known_hosts"),
        )));
        let host = Host {
            id: HostId::from(format!("{user}-shell")),
            name: "shell".into(),
            address: sshd.host.clone(),
            port: sshd.port,
            user: user.into(),
            auth: HostAuth::Password,
            jump_host: None,
            group_id: None,
            terminal_scheme: None,
            identities_only: false,
            forward_agent: false,
            keepalive_seconds: None,
            post_login_command: post_login_command.map(str::to_owned),
            default_directory: None,
            forwards: Vec::new(),
        };
        let options = RemoteTerminalOptions {
            shell_integration,
            post_login_command: host.post_login_command.clone(),
            ..RemoteTerminalOptions::default()
        };
        let connect = move || {
            let (manager, host) = (manager.clone(), host.clone());
            async move { manager.connect(&host, Arc::new(TrustingPrompter)).await }
        };
        let (tx, rx) = mpsc::unbounded_channel();
        let terminal = RemoteTerminal::open_with(connect, options, SIZE, move |e| {
            let _ = tx.send(e);
        })
        .await
        .unwrap();
        Self {
            terminal,
            rx,
            screen: vt100::Parser::new(SIZE.rows, SIZE.cols, 0),
            output: Vec::new(),
            integration: Vec::new(),
            connection: None,
            _known_hosts: dir,
        }
    }

    /// Takes in events for `within`, or until `done` says so; returns the
    /// directories reported meanwhile.
    async fn run(
        &mut self,
        within: Duration,
        mut done: impl FnMut(&Self, &[String]) -> bool,
    ) -> Vec<String> {
        let deadline = Instant::now() + within;
        let mut cwds = Vec::new();
        while !done(self, &cwds) {
            let left = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(left, self.rx.recv()).await {
                Err(_) => break,
                Ok(Some(TerminalEvent::Output(bytes))) => {
                    self.screen.process(&bytes);
                    self.output.extend_from_slice(&bytes);
                }
                Ok(Some(TerminalEvent::Cwd(path))) => cwds.push(path),
                Ok(Some(TerminalEvent::ShellIntegration(event))) => self.integration.push(event),
                Ok(Some(TerminalEvent::Connection(state))) => self.connection = Some(state),
                Ok(other) => panic!("unexpected {other:?}; output so far: {}", self.text()),
            }
        }
        cwds
    }

    /// Waits for the next directory report.
    async fn next_cwd(&mut self) -> String {
        let cwds = self
            .run(Duration::from_secs(10), |_, cwds| !cwds.is_empty())
            .await;
        cwds.into_iter()
            .next()
            .unwrap_or_else(|| panic!("no directory reported; output: {}", self.text()))
    }

    /// Lets the shell finish drawing (some output, then none for a moment).
    async fn settle(&mut self) -> Vec<String> {
        let mut cwds = Vec::new();
        loop {
            let before = self.output.len();
            cwds.extend(self.run(Duration::from_millis(500), |_, _| false).await);
            if self.output.len() == before && before > 0 {
                return cwds;
            }
        }
    }

    fn type_line(&mut self, line: &str) {
        self.terminal.write(format!("{line}\r").as_bytes()).unwrap();
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output).into_owned()
    }

    /// The non-blank rows of the screen.
    fn rows(&self) -> Vec<String> {
        self.screen
            .screen()
            .contents()
            .lines()
            .map(|l| l.trim_end().to_owned())
            .filter(|l| !l.is_empty())
            .collect()
    }
}

/// Opens a shell with ShellIntegration, checks the first prompt, then `cd`s
/// into a directory with spaces and non-ASCII characters.
async fn follows_cd(user: &str, home: &str, prompt: &str) {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let mut shell = Shell::open(&sshd, user, true).await;

    assert_eq!(shell.next_cwd().await, home);
    shell.settle().await;
    let rows = shell.rows();
    let prompts: Vec<_> = rows.iter().filter(|r| r.contains("@ssh:")).collect();
    assert_eq!(
        prompts,
        [prompt],
        "one prompt and no echoed line on screen: {rows:#?}"
    );
    assert_eq!(rows.last().map(String::as_str), Some(prompt));

    // Typed as octal escapes: the test server's locale is C, where line
    // editors mangle typed UTF-8.
    shell.type_line(&format!(
        r#"d=$(printf '/tmp/{user} integration/\346\227\245\346\234\254 dir'); mkdir -p "$d" && cd "$d""#
    ));
    assert_eq!(
        shell.next_cwd().await,
        format!("/tmp/{user} integration/日本 dir")
    );
    shell.type_line("cd /srv/files/docs");
    assert_eq!(shell.next_cwd().await, "/srv/files/docs");
    shell.type_line("cd ..");
    assert_eq!(shell.next_cwd().await, "/srv/files");

    shell.settle().await;
    let screen = shell.rows().join("\n");
    assert!(
        !screen.contains("sshastra") && !screen.contains("VERSION"),
        "the injected line never shows:\n{screen}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn bash_reports_its_directory_after_cd() {
    follows_cd(support::USER, "/home/tester", "tester@ssh:~$").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn zsh_reports_its_directory_after_cd() {
    follows_cd(support::ZSH_USER, "/home/zester", "zester@ssh:~%").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_injected_line_stays_out_of_bash_history() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let mut shell = Shell::open(&sshd, support::USER, true).await;
    shell.next_cwd().await;
    shell.type_line("history | grep -c '[_]_sshastra'");
    shell.settle().await;
    let rows = shell.rows();
    assert_eq!(rows[rows.len() - 2], "0", "{rows:#?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn with_shell_integration_off_nothing_is_injected_but_a_manual_report_works() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let mut shell = Shell::open(&sshd, support::USER, false).await;
    let cwds = shell.settle().await;
    assert!(cwds.is_empty(), "no hook, no reports: {cwds:?}");
    assert_eq!(
        shell.integration,
        [ShellIntegrationEvent::Availability {
            status: ShellIntegrationStatus::Disabled
        }]
    );
    assert_eq!(
        shell.rows().last().map(String::as_str),
        Some("tester@ssh:~$")
    );

    shell.type_line("cd /srv/files");
    assert!(shell.settle().await.is_empty());

    shell.terminal.write(REPORT_CWD.as_bytes()).unwrap();
    assert_eq!(shell.next_cwd().await, "/srv/files");
}

async fn reports_command_markers(user: &str) {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let mut shell = Shell::open(&sshd, user, true).await;
    shell.next_cwd().await;
    shell.settle().await;
    assert_eq!(
        shell.integration.last(),
        Some(&ShellIntegrationEvent::PromptStart)
    );
    assert_eq!(
        shell.integration.first(),
        Some(&ShellIntegrationEvent::Availability {
            status: ShellIntegrationStatus::Available
        })
    );
    shell.integration.clear();

    let command = r#"printf '%s\n' 'hello; 100%' && true"#;
    shell.type_line(command);
    shell.settle().await;
    assert_eq!(
        shell.integration,
        [
            ShellIntegrationEvent::CommandStart {
                command_line: Some(command.into())
            },
            ShellIntegrationEvent::CommandEnd { exit_code: 0 },
            ShellIntegrationEvent::PromptStart,
        ]
    );
    assert!(shell.rows().iter().any(|line| line == "hello; 100%"));
    assert!(
        shell
            .rows()
            .iter()
            .all(|line| !line.contains("6973") && !line.contains("sshastra")),
        "{:?}",
        shell.rows()
    );

    shell.integration.clear();
    shell.type_line("false");
    shell.settle().await;
    assert_eq!(
        shell.integration,
        [
            ShellIntegrationEvent::CommandStart {
                command_line: Some("false".into())
            },
            ShellIntegrationEvent::CommandEnd { exit_code: 1 },
            ShellIntegrationEvent::PromptStart,
        ]
    );

    shell.integration.clear();
    shell.type_line("");
    shell.settle().await;
    assert_eq!(shell.integration, [ShellIntegrationEvent::PromptStart]);
}

#[tokio::test(flavor = "multi_thread")]
async fn bash_reports_command_markers_without_changing_the_screen() {
    reports_command_markers(support::USER).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn zsh_reports_command_markers_without_changing_the_screen() {
    reports_command_markers(support::ZSH_USER).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unsupported_shell_reports_why_integration_is_unavailable() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let mut shell = Shell::open(&sshd, "dashuser", true).await;
    assert!(shell.settle().await.is_empty());
    assert_eq!(
        shell.integration,
        [ShellIntegrationEvent::Availability {
            status: ShellIntegrationStatus::Unsupported
        }]
    );
    assert!(shell.rows().last().is_some_and(|line| line == "$"));
}

const POST_LOGIN_COMMAND: &str = r#"printf 'startup:%s\n' 'finished'"#;
const POST_LOGIN_OUTPUT: &str = "startup:finished";

/// Counts exact output rows; the echoed command cannot match its formatted output.
fn assert_post_login_runs(shell: &Shell, expected: usize) {
    let rows = shell.rows();
    let count = rows.iter().filter(|row| *row == POST_LOGIN_OUTPUT).count();
    assert_eq!(count, expected, "terminal rows: {rows:#?}");
}

async fn runs_post_login_command_with_shell_integration(user: &str) {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let mut shell = Shell::open_with_command(&sshd, user, true, Some(POST_LOGIN_COMMAND)).await;
    shell.settle().await;

    assert_post_login_runs(&shell, 1);
    assert!(
        shell
            .integration
            .contains(&ShellIntegrationEvent::CommandStart {
                command_line: Some(POST_LOGIN_COMMAND.into()),
            }),
        "the installed hook should report the post-login command: {:?}",
        shell.integration,
    );

    shell.type_line("true");
    shell.settle().await;
    assert_post_login_runs(&shell, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn bash_runs_post_login_command_once_after_integration_setup() {
    runs_post_login_command_with_shell_integration(support::USER).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn zsh_runs_post_login_command_once_after_integration_setup() {
    runs_post_login_command_with_shell_integration(support::ZSH_USER).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_post_login_command_with_shell_integration_disabled() {
    let Some(sshd) = support::sshd(Service::Ssh) else {
        return;
    };
    let mut shell =
        Shell::open_with_command(&sshd, support::USER, false, Some(POST_LOGIN_COMMAND)).await;
    assert!(shell.settle().await.is_empty());
    assert_eq!(
        shell.integration,
        [ShellIntegrationEvent::Availability {
            status: ShellIntegrationStatus::Disabled,
        }]
    );
    assert_post_login_runs(&shell, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_post_login_command_again_in_the_reconnected_shell() {
    let Some(sshd) = support::sshd(Service::Flaky) else {
        return;
    };
    let mut shell =
        Shell::open_with_command(&sshd, support::USER, true, Some(POST_LOGIN_COMMAND)).await;
    shell.settle().await;
    assert_post_login_runs(&shell, 1);

    sshd.drop_connections();
    shell
        .run(Duration::from_secs(30), |shell, _| {
            shell.connection == Some(ConnectionState::Connected)
        })
        .await;
    assert_eq!(shell.connection, Some(ConnectionState::Connected));
    shell.settle().await;

    assert_post_login_runs(&shell, 2);
}
