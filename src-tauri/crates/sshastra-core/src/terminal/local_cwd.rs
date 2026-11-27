use std::fs::File;
use std::io::{self, Read};
use std::os::fd::BorrowedFd;
use std::path::Path;
use std::time::{Duration, Instant};

use portable_pty::MasterPty;
use rustix::event::{poll, PollFd, PollFlags, Timespec};
use rustix::io::Errno;

use super::TerminalEvent;

const SAMPLE_INTERVAL: Duration = Duration::from_millis(250);

/// Uses the PTY reader thread to sample the shell after output (including the
/// prompt after `cd`). A burst gets a trailing check, then the reader blocks
/// until more output. There are no periodic wakeups while the PTY is idle.
pub(super) struct LocalCwdReader {
    file: File,
    pid: u32,
    cwd: Option<String>,
    next_sample: Instant,
    pending: bool,
}

impl LocalCwdReader {
    pub(super) fn new(master: &dyn MasterPty, pid: u32) -> io::Result<Option<Self>> {
        let Some(fd) = master.as_raw_fd() else {
            return Ok(None);
        };
        // SAFETY: `master` owns the fd and remains borrowed until it is duplicated.
        let fd = unsafe { BorrowedFd::borrow_raw(fd) };
        Ok(Some(Self {
            file: fd.try_clone_to_owned()?.into(),
            pid,
            cwd: None,
            next_sample: Instant::now(),
            pending: true,
        }))
    }

    pub(super) fn read(
        &mut self,
        buf: &mut [u8],
        sink: &mut impl FnMut(TerminalEvent),
    ) -> io::Result<usize> {
        while self.pending {
            let wait = self.next_sample.saturating_duration_since(Instant::now());
            if wait.is_zero() {
                self.sample(sink);
                break;
            }
            let timeout = Timespec::try_from(wait).expect("timeout is at most SAMPLE_INTERVAL");
            match poll(
                &mut [PollFd::new(&self.file, PollFlags::IN)],
                Some(&timeout),
            ) {
                Ok(0) | Err(Errno::INTR) => continue,
                _ => break,
            }
        }
        let count = self.file.read(buf)?;
        self.pending = count != 0;
        Ok(count)
    }

    fn sample(&mut self, sink: &mut impl FnMut(TerminalEvent)) {
        self.pending = false;
        self.next_sample = Instant::now() + SAMPLE_INTERVAL;
        if let Some(cwd) = process_cwd(self.pid).filter(|cwd| Path::new(cwd).is_absolute()) {
            if self.cwd.as_ref() != Some(&cwd) {
                sink(TerminalEvent::Cwd(cwd.clone()));
                self.cwd = Some(cwd);
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()?
        .into_os_string()
        .into_string()
        .ok()
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<String> {
    use std::ffi::CStr;
    use std::mem::{size_of, MaybeUninit};

    let pid = libc::pid_t::try_from(pid).ok()?;
    let mut info = MaybeUninit::<libc::proc_vnodepathinfo>::zeroed();
    let size = size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    // SAFETY: the buffer holds the structure expected by PROC_PIDVNODEPATHINFO.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    // SAFETY: the call succeeded and reported writing the full structure.
    let info = unsafe { info.assume_init() };
    let path = info.pvi_cdir.vip_path.as_flattened();
    if !path.contains(&0) {
        return None;
    }
    // SAFETY: the path is terminated within the fixed-size buffer.
    let path = unsafe { CStr::from_ptr(path.as_ptr()) };
    path.to_str().ok().map(str::to_owned)
}
