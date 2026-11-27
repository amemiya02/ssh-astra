//! One native idle sleep request, held for the lifetime of a transfer activity.

#[cfg(target_os = "linux")]
#[path = "sleep_linux.rs"]
mod platform;

pub(super) use platform::Lease;

pub(super) fn acquire() -> Option<Lease> {
    match platform::acquire(reason()) {
        Ok(lease) => Some(lease),
        Err(error) => {
            log::debug!("transfer sleep protection unavailable: {error}");
            None
        }
    }
}

fn reason() -> &'static str {
    if let Ok(preferences) = whoami::lang_prefs() {
        for language in preferences.message_langs() {
            if ["zh-TW", "zh-HK", "zh-MO"]
                .iter()
                .any(|tag| language == *tag)
            {
                return "SSH Astra 正在傳輸檔案";
            }
            let tag = language.to_string();
            let base = tag.split(['/', '-', '_']).next().unwrap_or_default();
            if base == "zh" {
                return "SSH Astra 正在传输文件";
            }
            if base == "en" {
                break;
            }
        }
    }
    "SSH Astra is transferring files"
}

#[cfg(target_os = "macos")]
mod platform {
    use std::convert::Infallible;

    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::ProtocolObject;
    use objc2_foundation::{NSActivityOptions, NSObjectProtocol, NSProcessInfo, NSString};

    pub(in super::super) struct Lease(Retained<ProtocolObject<dyn NSObjectProtocol>>);

    pub(super) fn acquire(reason: &str) -> Result<Lease, Infallible> {
        Ok(autoreleasepool(|_| {
            Lease(
                NSProcessInfo::processInfo().beginActivityWithOptions_reason(
                    NSActivityOptions::IdleSystemSleepDisabled,
                    &NSString::from_str(reason),
                ),
            )
        }))
    }

    impl Drop for Lease {
        fn drop(&mut self) {
            // The token came from beginActivity on the same process info.
            autoreleasepool(|_| unsafe { NSProcessInfo::processInfo().endActivity(&self.0) });
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Power::{
        PowerClearRequest, PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest,
    };
    use windows_sys::Win32::System::SystemServices::POWER_REQUEST_CONTEXT_VERSION;
    use windows_sys::Win32::System::Threading::{
        POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
    };

    pub(in super::super) struct Lease(OwnedHandle);

    pub(super) fn acquire(reason: &str) -> io::Result<Lease> {
        let mut reason: Vec<_> = reason.encode_utf16().chain(std::iter::once(0)).collect();
        let context = REASON_CONTEXT {
            Version: POWER_REQUEST_CONTEXT_VERSION,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 {
                SimpleReasonString: reason.as_mut_ptr(),
            },
        };
        // The context and its terminated reason stay live throughout the call.
        let handle = unsafe { PowerCreateRequest(&context) };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // A successful PowerCreateRequest returns an owned handle to be closed.
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        if unsafe { PowerSetRequest(handle.as_raw_handle(), PowerRequestSystemRequired) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Lease(handle))
    }

    impl Drop for Lease {
        fn drop(&mut self) {
            // This handle owns exactly one SystemRequired request, then it closes.
            unsafe { PowerClearRequest(self.0.as_raw_handle(), PowerRequestSystemRequired) };
        }
    }
}
