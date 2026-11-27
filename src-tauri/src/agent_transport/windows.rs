use std::io;
use std::mem::{size_of, size_of_val};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::null_mut;
use std::time::Duration;

use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use windows_sys::Win32::Foundation::{LocalFree, ERROR_PIPE_BUSY, HANDLE, HLOCAL};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION;
use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::super::MAX_CLIENTS;

#[derive(Clone)]
pub struct Endpoint {
    name: String,
    sid: String,
}

impl Endpoint {
    pub fn current_user() -> io::Result<Self> {
        // This pseudo-handle is valid in this process and is not closed.
        let sid = user_sid(unsafe { GetCurrentProcess() })?;
        Ok(Self {
            name: format!(r"\\.\pipe\sshastra-agent-{sid}"),
            sid,
        })
    }

    #[cfg(test)]
    pub fn isolated(directory: &std::path::Path) -> Self {
        let mut endpoint = Self::current_user().unwrap();
        endpoint.name.push('-');
        endpoint
            .name
            .push_str(&directory.file_name().unwrap().to_string_lossy());
        endpoint
    }

    pub async fn connect(&self) -> io::Result<NamedPipeClient> {
        loop {
            match ClientOptions::new()
                .security_qos_flags(SECURITY_IDENTIFICATION)
                .open(&self.name)
            {
                Ok(client) => {
                    verify_server(&client, &self.sid)?;
                    return Ok(client);
                }
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn create(&self, first: bool) -> io::Result<NamedPipeServer> {
        let sddl: Vec<u16> = format!("D:P(A;;GA;;;{})", self.sid)
            .encode_utf16()
            .chain([0])
            .collect();
        let mut descriptor = null_mut();
        // Convert copies the SDDL into its own allocation.
        check(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        })?;
        let descriptor = LocalAllocation(descriptor);
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        // Both the attributes and descriptor live through CreateNamedPipeW.
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .max_instances(MAX_CLIENTS + 1)
                .in_buffer_size(16 * 1024)
                .out_buffer_size(16 * 1024)
                .create_with_security_attributes_raw(
                    &self.name,
                    (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
                )
        }
    }
}

pub struct Listener {
    endpoint: Endpoint,
    server: NamedPipeServer,
}

impl Listener {
    pub fn bind(endpoint: &Endpoint) -> io::Result<Self> {
        Ok(Self {
            endpoint: endpoint.clone(),
            server: endpoint.create(true)?,
        })
    }

    pub async fn accept(&mut self) -> io::Result<NamedPipeServer> {
        if let Err(error) = self.server.connect().await {
            let _ = self.server.disconnect();
            return Err(error);
        }
        // Keep a waiting instance open as the accepted one goes to a worker.
        let next = self.endpoint.create(false);
        if next.is_err() {
            let _ = self.server.disconnect();
        }
        Ok(std::mem::replace(&mut self.server, next?))
    }
}

fn verify_server(client: &NamedPipeClient, sid: &str) -> io::Result<()> {
    let mut pid = 0;
    // The pipe handle remains owned by the live client while querying it.
    check(unsafe { GetNamedPipeServerProcessId(client.as_raw_handle(), &mut pid) })?;
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    // OpenProcess returned an owned handle.
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    if user_sid(process.as_raw_handle())? != sid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Agent access pipe belongs to another user",
        ));
    }
    Ok(())
}

struct LocalAllocation(HLOCAL);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // The Windows conversion APIs allocate with LocalAlloc.
        unsafe { LocalFree(self.0) };
    }
}

fn user_sid(process: HANDLE) -> io::Result<String> {
    let mut token = null_mut();
    // OpenProcessToken returns an owned handle when successful.
    check(unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) })?;
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut len = 0;
    unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut len) };
    if len < size_of::<TOKEN_USER>() as u32 {
        return Err(io::Error::last_os_error());
    }
    // Allocate enough aligned storage for TOKEN_USER and its SID.
    let mut data = vec![0usize; (len as usize).div_ceil(size_of::<usize>())];
    check(unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            data.as_mut_ptr().cast(),
            size_of_val(data.as_slice()) as u32,
            &mut len,
        )
    })?;
    let mut string = null_mut();
    // The successful TokenUser query filled the aligned buffer and its SID.
    check(unsafe {
        let user = &*data.as_ptr().cast::<TOKEN_USER>();
        ConvertSidToStringSidW(user.User.Sid, &mut string)
    })?;
    let allocation = LocalAllocation(string.cast());
    // ConvertSidToStringSidW returned an allocated, NUL-terminated string.
    let mut end = string;
    unsafe {
        while *end != 0 {
            end = end.add(1);
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(
            string,
            end.offset_from(string) as usize,
        ));
        drop(allocation);
        Ok(text)
    }
}

fn check(success: i32) -> io::Result<()> {
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
