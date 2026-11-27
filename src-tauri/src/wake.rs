//! Desktop system wake notifications. Tauri's `Resumed` event comes from event-loop polling.

use sshastra_core::terminal::TerminalRegistry;
use tauri::{AppHandle, Manager};

pub(crate) use platform::Listener;

fn resumed(app: &AppHandle) {
    #[cfg(windows)]
    app.state::<crate::commands::transfers::TransfersState>()
        .activity
        .resumed(app);
    log::info!("system resumed, checking for disconnected Terminals");
    app.state::<TerminalRegistry>().reconnect_disconnected();
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};

    use super::{resumed, AppHandle};

    pub struct Listener {
        center: Retained<NSNotificationCenter>,
        observer: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    }

    impl Listener {
        pub fn start(app: AppHandle) -> Option<Self> {
            let center = NSWorkspace::sharedWorkspace().notificationCenter();
            let callback = RcBlock::new(move |_: NonNull<NSNotification>| resumed(&app));
            // The closure captures a thread-safe AppHandle and uses no UI objects.
            let observer = unsafe {
                center.addObserverForName_object_queue_usingBlock(
                    Some(NSWorkspaceDidWakeNotification),
                    None,
                    None,
                    &callback,
                )
            };
            Some(Self { center, observer })
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            // This token was registered on this notification center.
            unsafe { self.center.removeObserver(self.observer.as_ref()) };
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use std::sync::Mutex;

    use windows_sys::Win32::System::Power::{
        PowerRegisterSuspendResumeNotification, PowerUnregisterSuspendResumeNotification,
        DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, HPOWERNOTIFY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC,
    };

    use super::{resumed, AppHandle};

    // The native callback may run on any thread, including during teardown.
    // Keeping app state here avoids passing a pointer with a shorter lifetime to Windows.
    static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

    pub struct Listener(HPOWERNOTIFY);

    impl Listener {
        pub fn start(app: AppHandle) -> Option<Self> {
            *APP.lock().ok()? = Some(app);
            let mut parameters = DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
                Callback: Some(on_power_event),
                Context: null_mut(),
            };
            let mut registration = null_mut();
            // The callback uses static storage and the out-pointer lives through the call.
            let error = unsafe {
                PowerRegisterSuspendResumeNotification(
                    DEVICE_NOTIFY_CALLBACK,
                    (&mut parameters as *mut DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS).cast(),
                    &mut registration,
                )
            };
            if error == 0 {
                Some(Self(registration as HPOWERNOTIFY))
            } else {
                *APP.lock().ok()? = None;
                log::warn!("could not subscribe to Windows system wake: {error}");
                None
            }
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            if let Ok(mut app) = APP.lock() {
                *app = None;
            }
            // This handle came from a successful registration.
            unsafe { PowerUnregisterSuspendResumeNotification(self.0) };
        }
    }

    unsafe extern "system" fn on_power_event(
        _: *const c_void,
        event: u32,
        _: *const c_void,
    ) -> u32 {
        // Windows may also report a user-initiated resume for the same wake.
        if event == PBT_APMRESUMEAUTOMATIC {
            let app = APP.lock().ok().and_then(|app| app.clone());
            if let Some(app) = app {
                resumed(&app);
            }
        }
        0
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use futures_util::StreamExt;

    use super::{resumed, AppHandle};

    pub struct Listener(tauri::async_runtime::JoinHandle<()>);

    impl Listener {
        pub fn start(app: AppHandle) -> Option<Self> {
            Some(Self(tauri::async_runtime::spawn(async move {
                match watch(&app).await {
                    Ok(()) => log::debug!("Linux system wake notifications ended"),
                    Err(error) => {
                        log::debug!("Linux system wake notifications unavailable: {error}")
                    }
                }
            })))
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            self.0.abort();
        }
    }

    async fn watch(app: &AppHandle) -> zbus::Result<()> {
        let bus = zbus::Connection::system().await?;
        let logind = zbus::Proxy::new(
            &bus,
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
        )
        .await?;
        let mut sleep = logind.receive_signal("PrepareForSleep").await?;
        while let Some(signal) = sleep.next().await {
            if matches!(signal.body().deserialize::<bool>(), Ok(false)) {
                resumed(app);
            }
        }
        Ok(())
    }
}
