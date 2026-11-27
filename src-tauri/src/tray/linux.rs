use std::time::Duration;

use tauri::WebviewWindow;

const PANEL_CHECK: Duration = Duration::from_secs(5);

pub(super) fn indicator_library_available() -> bool {
    // libappindicator panics if neither of these libraries can be loaded.
    ["libayatana-appindicator3.so.1", "libappindicator3.so.1"]
        .into_iter()
        .any(|name| unsafe { libloading::Library::new(name) }.is_ok())
}

pub(super) async fn panel_available() -> bool {
    tokio::time::timeout(Duration::from_millis(500), async {
        let Ok(bus) = zbus::Connection::session().await else {
            return false;
        };
        // AppIndicator registers against the KDE StatusNotifierWatcher service.
        let Ok(watcher) = zbus::Proxy::new(
            &bus,
            "org.kde.StatusNotifierWatcher",
            "/StatusNotifierWatcher",
            "org.kde.StatusNotifierWatcher",
        )
        .await
        else {
            return false;
        };
        watcher
            .get_property::<bool>("IsStatusNotifierHostRegistered")
            .await
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

pub(super) fn reveal_if_panel_disappears(window: WebviewWindow) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(PANEL_CHECK).await;
            if !matches!(window.is_visible(), Ok(false)) {
                return;
            }
            if !panel_available().await {
                // Some watchers stop exposing the host without sending an unregister signal.
                let handle = window.app_handle().clone();
                let _ = handle.run_on_main_thread(move || {
                    if matches!(window.is_visible(), Ok(false)) {
                        let _ = super::windows::present(&window);
                    }
                });
                return;
            }
        }
    });
}
