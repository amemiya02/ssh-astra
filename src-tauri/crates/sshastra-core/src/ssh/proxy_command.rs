//! A first-hop SSH transport owned by the Connection and its byte stream.

use std::io;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, Join, ReadBuf};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::task::JoinHandle;

use super::ConnectError;
use crate::hosts::Host;
use crate::proxy::{endpoint_host, normalize_command};

const STDERR_LIMIT: usize = 4096;

pub(super) fn start(command: &str, host: &Host) -> Result<(Stream, Process), ConnectError> {
    let template = normalize_command(command).map_err(|_| ConnectError::ProxyCommandInvalid)?;
    let script = expand(&template, &host.address, host.port, &host.user)?;
    let mut child = command_shell(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(ConnectError::ProxyCommandStart)?;
    #[cfg(windows)]
    let job = windows_job::attach(&child).map_err(ConnectError::ProxyCommandStart)?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let state = Arc::new(State {
        child: Mutex::new(Some(CommandChild {
            child,
            #[cfg(windows)]
            _job: job,
        })),
        transport_failed: AtomicBool::new(false),
        stderr: Mutex::new(Vec::new()),
    });
    let capture = tokio::spawn(capture_stderr(stderr, Arc::clone(&state)));
    Ok((
        Stream {
            pipes: tokio::io::join(stdout, stdin),
            state: Arc::clone(&state),
        },
        Process { state, capture },
    ))
}

/// Insert only validated endpoint and account tokens. The same alphabet is
/// safe whether a template uses bare words, quotes, or another shell.
fn expand(template: &str, host: &str, port: u16, user: &str) -> Result<String, ConnectError> {
    let mut output = String::with_capacity(template.len());
    let mut chars = template.chars();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            output.push(ch);
            continue;
        }
        match chars.next() {
            Some('h') => {
                if host.starts_with('-') || endpoint_host(host).is_none() {
                    return Err(ConnectError::ProxyCommandTarget);
                }
                output.push_str(host.trim_matches(['[', ']']));
            }
            Some('p') if port != 0 => output.push_str(&port.to_string()),
            Some('p') => return Err(ConnectError::ProxyCommandTarget),
            Some('r') => {
                if user.is_empty()
                    || user.starts_with('-')
                    || !user
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_.@-".contains(&b))
                {
                    return Err(ConnectError::ProxyCommandTarget);
                }
                output.push_str(user);
            }
            Some('%') => output.push('%'),
            Some(other) => {
                output.push('%');
                output.push(other);
            }
            None => output.push('%'),
        }
    }
    Ok(output)
}

#[cfg(unix)]
fn command_shell(script: &str) -> Command {
    let shell = std::env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| {
            portable_pty::CommandBuilder::new_default_prog()
                .get_shell()
                .into()
        });
    let mut command = Command::new(shell);
    command.arg("-c").arg(script).process_group(0);
    command
}

#[cfg(windows)]
fn command_shell(script: &str) -> Command {
    use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};

    let shell = std::env::var_os("ComSpec")
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| "cmd.exe".into());
    let mut command = Command::new(shell);
    command
        .args(["/d", "/s", "/v:off", "/c"])
        .raw_arg(format!("\"{script}\""))
        .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    command
}

struct CommandChild {
    child: Child,
    #[cfg(windows)]
    _job: std::os::windows::io::OwnedHandle,
}

impl Drop for CommandChild {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(group) = self
            .child
            .id()
            .and_then(|id| rustix::process::Pid::from_raw(id as i32))
        {
            // Keep the child unreaped until the signal has been sent so its
            // process group ID still belongs to this command.
            let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
        }
        // On Windows closing the job handle ends descendants. Tokio reaps
        // the shell on drop after the kill.
        let _ = self.child.start_kill();
    }
}

struct State {
    child: Mutex<Option<CommandChild>>,
    transport_failed: AtomicBool,
    stderr: Mutex<Vec<u8>>,
}

impl State {
    fn stop(&self) {
        self.child.lock().unwrap_or_else(|p| p.into_inner()).take();
    }
}

async fn capture_stderr(mut stderr: ChildStderr, state: Arc<State>) {
    let mut buffer = [0; 1024];
    while let Ok(length @ 1..) = stderr.read(&mut buffer).await {
        let mut captured = state.stderr.lock().unwrap_or_else(|p| p.into_inner());
        let count = length.min(STDERR_LIMIT - captured.len());
        captured.extend_from_slice(&buffer[..count]);
    }
}

pub(super) struct Process {
    state: Arc<State>,
    capture: JoinHandle<()>,
}

impl Process {
    pub(super) async fn connect_error(mut self, error: ConnectError) -> ConnectError {
        self.state.stop();
        if !matches!(error, ConnectError::Protocol(_))
            || !self.state.transport_failed.load(Ordering::Relaxed)
        {
            return error;
        }
        // EOF on stdout may arrive just before the stderr task drains the last
        // bytes. A descendant that kept stderr open cannot hold up the error.
        let _ = tokio::time::timeout(Duration::from_millis(100), &mut self.capture).await;
        let stderr = self.state.stderr.lock().unwrap_or_else(|p| p.into_inner());
        let text = String::from_utf8_lossy(&stderr);
        let detail: String = text
            .chars()
            .filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\t'))
            .collect();
        let detail = detail.trim();
        ConnectError::ProxyCommandFailed {
            stderr: detail.to_owned(),
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.state.stop();
        self.capture.abort();
    }
}

pub(super) struct Stream {
    pipes: Join<ChildStdout, ChildStdin>,
    state: Arc<State>,
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.state.stop();
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let remaining = buf.remaining();
        let result = Pin::new(&mut self.pipes).poll_read(cx, buf);
        if matches!(result, Poll::Ready(Err(_)))
            || (matches!(result, Poll::Ready(Ok(())))
                && remaining != 0
                && buf.remaining() == remaining)
        {
            self.state.transport_failed.store(true, Ordering::Relaxed);
        }
        result
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.pipes).poll_write(cx, buf);
        if matches!(result, Poll::Ready(Err(_))) {
            self.state.transport_failed.store(true, Ordering::Relaxed);
        }
        result
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.pipes).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.pipes).poll_shutdown(cx)
    }
}

#[cfg(windows)]
mod windows_job {
    use std::io;
    use std::mem::size_of;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr::null;

    use tokio::process::Child;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    pub(super) fn attach(child: &Child) -> io::Result<OwnedHandle> {
        // The returned noninheritable handle is owned by this process only.
        let job = unsafe { CreateJobObjectW(null(), null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = unsafe { OwnedHandle::from_raw_handle(job) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let process = child.raw_handle().expect("child has not been waited on");
        // The handles and limits remain valid throughout both calls.
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
            || unsafe { AssignProcessToJobObject(job.as_raw_handle(), process) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        // The shell was created suspended, so it could not spawn a child
        // before assignment. Its only thread is the one to resume.
        resume(child.id().expect("child has not been waited on"))?;
        Ok(job)
    }

    fn resume(pid: u32) -> io::Result<()> {
        // The snapshot and thread handles below are each owned by this call.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let len = size_of::<THREADENTRY32>() as u32;
        let mut entry = THREADENTRY32 {
            dwSize: len,
            ..Default::default()
        };
        let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
        while found != 0 {
            if entry.th32OwnerProcessID == pid {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
                if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                    return Err(io::Error::last_os_error());
                }
                return Ok(());
            }
            entry.dwSize = len;
            found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
        }
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_expand_to_the_host_port_and_account() {
        let script = expand(
            "relay --host '%h' --port \"%p\" --user %r --target %h:%p --format %%s",
            "vpn.example",
            2222,
            "build-user",
        )
        .unwrap();
        assert_eq!(
            script,
            "relay --host 'vpn.example' --port \"2222\" --user build-user --target vpn.example:2222 --format %s"
        );
        assert_eq!(expand("nc %h %p", "[::1]", 22, "ops").unwrap(), "nc ::1 22");
    }

    #[test]
    fn rejects_values_that_would_split_a_substituted_word() {
        assert!(matches!(
            expand("relay %h %p", "file server", 22, "ops"),
            Err(ConnectError::ProxyCommandTarget)
        ));
        assert!(matches!(
            expand("relay %r", "vpn.example", 22, "build user"),
            Err(ConnectError::ProxyCommandTarget)
        ));
        assert_eq!(
            expand("relay vpn.example", "file server", 22, "build user").unwrap(),
            "relay vpn.example"
        );
    }
}
