use std::convert::Infallible;
use std::time::Duration;

use tokio::sync::oneshot;
use tokio::time::timeout;
use zbus::zvariant::OwnedFd;
use zbus::Connection;

const APP: &str = "SSH Astra";
const GNOME: &str = "org.gnome.SessionManager";
const GNOME_PATH: &str = "/org/gnome/SessionManager";
const KDE: &str = "org.freedesktop.PowerManagement.Inhibit";
const KDE_PATH: &str = "/org/freedesktop/PowerManagement/Inhibit";
const BUS_TIMEOUT: Duration = Duration::from_secs(2);

pub(in super::super) struct Lease {
    // Dropping this sender cancels acquisition or releases the active request.
    _release: oneshot::Sender<()>,
}

pub(super) fn acquire(reason: &'static str) -> Result<Lease, Infallible> {
    let (release, mut released) = oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let session = tokio::select! {
            biased;
            _ = &mut released => return,
            result = timeout(BUS_TIMEOUT, inhibit_session(reason)) => result,
        };
        if let Ok(Ok(lease)) = session {
            let _ = released.await;
            // The dedicated bus connection also releases its cookies if this call fails.
            let _ = timeout(BUS_TIMEOUT, lease.release()).await;
            return;
        }

        let system = tokio::select! {
            biased;
            _ = &mut released => return,
            result = timeout(BUS_TIMEOUT, inhibit_system_idle(reason)) => result,
        };
        match system {
            Ok(Ok(fd)) => {
                let _ = released.await;
                drop(fd);
            }
            Ok(Err(error)) => log::debug!("transfer sleep protection unavailable: {error}"),
            Err(_) => log::debug!("transfer sleep protection request timed out"),
        }
    });
    Ok(Lease { _release: release })
}

struct SessionLease {
    connection: Connection,
    service: &'static str,
    path: &'static str,
    release_method: &'static str,
    cookie: u32,
}

impl SessionLease {
    async fn release(self) -> zbus::Result<()> {
        self.connection
            .call_method(
                Some(self.service),
                self.path,
                Some(self.service),
                self.release_method,
                &(self.cookie,),
            )
            .await?;
        Ok(())
    }
}

async fn inhibit_session(reason: &str) -> zbus::Result<SessionLease> {
    // An independent bus connection owns these requests. GNOME SessionManager
    // and Plasma PowerDevil release them automatically if that connection closes.
    let connection = Connection::session().await?;
    // Other desktops can expose the same interface with broader semantics
    // (including preventing the screen from blanking).
    if whoami::desktop_env() == Some(whoami::DesktopEnvironment::Plasma) {
        if let Ok(message) = connection
            .call_method(Some(KDE), KDE_PATH, Some(KDE), "Inhibit", &(APP, reason))
            .await
        {
            return Ok(SessionLease {
                connection,
                service: KDE,
                path: KDE_PATH,
                release_method: "UnInhibit",
                cookie: message.body().deserialize()?,
            });
        }
    }

    // GNOME's power daemon uses flag 4 for automatic suspend. Flag 8 would
    // also inhibit screen blanking and locking, so leave it unset.
    let message = connection
        .call_method(
            Some(GNOME),
            GNOME_PATH,
            Some(GNOME),
            "Inhibit",
            &(APP, 0u32, reason, 4u32),
        )
        .await?;
    Ok(SessionLease {
        connection,
        service: GNOME,
        path: GNOME_PATH,
        release_method: "Uninhibit",
        cookie: message.body().deserialize()?,
    })
}

async fn inhibit_system_idle(reason: &str) -> zbus::Result<OwnedFd> {
    // Fallback for sessions that rely on logind's automatic IdleAction. Explicit
    // sleep and hardware switches are outside this lock's scope.
    let bus = Connection::system().await?;
    let message = bus
        .call_method(
            Some("org.freedesktop.login1"),
            "/org/freedesktop/login1",
            Some("org.freedesktop.login1.Manager"),
            "Inhibit",
            &("idle", APP, reason, "block"),
        )
        .await?;
    message.body().deserialize()
}
