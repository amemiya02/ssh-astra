//! Approval and status for the shared OpenSSH sync setting.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::json;
use sshastra_core::hosts::{Host, HostStore, OpenSshReadReport};
use sshastra_core::settings::SettingsStore;
use sshastra_core::ssh::ConnectionSettings;
use sshastra_core::ssh_config::{read_user_config, ParseContext, UserConfig};
use sshastra_core::ssh_config_export::{
    ConfigExport, ExportError, ExportReport, IncludePlan, INCLUDE_LINE,
};
use tauri::{State, WebviewWindow};
use tokio::sync::watch;

use super::hosts::{local_username, HostsState};
use super::settings::{SettingsChange, SettingsChanges, SettingsState};
use crate::error::{CommandError, CommandResult};

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct OpenSshSettings {
    pub enabled: bool,
}

impl OpenSshSettings {
    pub const SECTION: &'static str = "openSshSync";
}

#[derive(Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct OpenSshStatus {
    enabled: bool,
    report: ExportReport,
    problem: Option<&'static str>,
    include_line: Option<&'static str>,
    read: Option<OpenSshReadReport>,
    read_problem: bool,
    read_approval: Option<u64>,
    startup_offer: bool,
}

struct Runtime {
    status: OpenSshStatus,
    connection: ConnectionSettings,
    previews: HashMap<String, (u64, IncludePlan)>,
    next_preview: u64,
    read_request: u64,
    read_snapshot: Option<UserConfig>,
}

pub struct OpenSshSync {
    home: Option<PathBuf>,
    export: Option<ConfigExport>,
    runtime: Mutex<Runtime>,
    changes: Arc<SettingsChanges>,
    startup_done: watch::Sender<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSshPreview {
    line: &'static str,
    adds_include: bool,
    approval: u64,
}

impl OpenSshSync {
    pub fn new(
        home: Option<PathBuf>,
        preferences: OpenSshSettings,
        connection: ConnectionSettings,
        changes: Arc<SettingsChanges>,
    ) -> Self {
        Self {
            startup_done: watch::Sender::new(!preferences.enabled || home.is_none()),
            export: home.clone().map(ConfigExport::new),
            home,
            runtime: Mutex::new(Runtime {
                status: OpenSshStatus {
                    enabled: preferences.enabled,
                    include_line: preferences.enabled.then_some(INCLUDE_LINE),
                    ..Default::default()
                },
                connection,
                previews: HashMap::new(),
                next_preview: 0,
                read_request: 0,
                read_snapshot: None,
            }),
            changes,
        }
    }

    fn export(&self) -> CommandResult<&ConfigExport> {
        self.export
            .as_ref()
            .ok_or_else(CommandError::open_ssh_home_unavailable)
    }

    fn publish(&self, status: &OpenSshStatus) -> SettingsChange {
        self.changes
            .publish(OpenSshSettings::SECTION.into(), json!(status), None)
    }

    /// The same lock is held while subscribing to settings changes so newer
    /// sync results cannot slip between the first snapshot and the watch.
    pub(super) fn with_status<T>(&self, read: impl FnOnce(&OpenSshStatus) -> T) -> T {
        let runtime = self.runtime.lock().unwrap_or_else(|p| p.into_inner());
        read(&runtime.status)
    }

    pub fn forget_preview(&self, window: &str) {
        let mut runtime = self.runtime.lock().unwrap_or_else(|p| p.into_inner());
        runtime.previews.remove(window);
    }

    pub fn preview(&self, window: &str) -> CommandResult<OpenSshPreview> {
        let mut runtime = self.runtime.lock().unwrap_or_else(|p| p.into_inner());
        runtime.previews.remove(window);
        let plan = self.export()?.preview()?;
        let adds_include = plan.adds_include();
        runtime.next_preview += 1;
        let approval = runtime.next_preview;
        runtime.previews.insert(window.to_owned(), (approval, plan));
        Ok(OpenSshPreview {
            line: INCLUDE_LINE,
            adds_include,
            approval,
        })
    }

    fn enable(
        &self,
        window: &str,
        approval: u64,
        hosts: &[Host],
        settings: &mut SettingsStore,
    ) -> CommandResult<SettingsChange> {
        let mut runtime = self.runtime.lock().unwrap_or_else(|p| p.into_inner());
        let (_, plan) = runtime
            .previews
            .remove(window)
            .filter(|(token, _)| *token == approval)
            .ok_or_else(CommandError::open_ssh_approval_expired)?;
        if runtime.status.enabled {
            return Ok(self.publish(&runtime.status));
        }
        let export = self.export()?;
        let report = export.enable(plan, hosts, &runtime.connection)?;
        if let Err(error) = settings.set(OpenSshSettings::SECTION, json!({ "enabled": true })) {
            if export.disable().is_err() {
                log::warn!("Could not clear the OpenSSH fragment after a settings write failure");
            }
            return Err(error.into());
        }
        runtime.previews.clear();
        runtime.status = OpenSshStatus {
            enabled: true,
            report,
            include_line: Some(INCLUDE_LINE),
            ..Default::default()
        };
        Ok(self.publish(&runtime.status))
    }

    fn disable(
        &self,
        hosts: Option<&[Host]>,
        settings: &mut SettingsStore,
    ) -> CommandResult<SettingsChange> {
        let mut runtime = self.runtime.lock().unwrap_or_else(|p| p.into_inner());
        if !runtime.status.enabled {
            return Ok(self.publish(&runtime.status));
        }
        // Leave foreign files and a missing home untouched. They cannot be
        // a fragment owned by this app.
        if let Some(export) = &self.export {
            match export.disable() {
                Ok(()) | Err(ExportError::FragmentExists) => {}
                Err(error) => return Err(error.into()),
            }
        }
        if let Err(error) = settings.set(OpenSshSettings::SECTION, json!({ "enabled": false })) {
            if let Some(hosts) = hosts {
                self.refresh(&mut runtime, hosts);
            }
            return Err(error.into());
        }
        runtime.previews.clear();
        runtime.read_snapshot = None;
        runtime.read_request += 1;
        runtime.status = OpenSshStatus {
            include_line: Some(INCLUDE_LINE),
            ..Default::default()
        };
        Ok(self.publish(&runtime.status))
    }

    pub fn rebuild(&self, hosts: &[Host], settings: Option<ConnectionSettings>) {
        let mut runtime = self.runtime.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(settings) = settings {
            runtime.connection = settings;
        }
        self.refresh(&mut runtime, hosts);
    }

    pub fn unavailable_hosts(&self) {
        self.startup_done.send_replace(true);
        let mut runtime = self.runtime.lock().unwrap_or_else(|p| p.into_inner());
        if runtime.status.enabled {
            runtime.status.problem = Some("hostsUnavailable");
        }
    }

    fn refresh(&self, runtime: &mut Runtime, hosts: &[Host]) {
        if !runtime.status.enabled {
            return;
        }
        let (report, problem) = match &self.export {
            Some(export) => match export.refresh(hosts, &runtime.connection) {
                Ok(report) => (report, None),
                Err(error) => (ExportReport::default(), Some(error.kind())),
            },
            None => (ExportReport::default(), Some("homeUnavailable")),
        };
        if runtime.status.report != report || runtime.status.problem != problem {
            runtime.status.report = report;
            runtime.status.problem = problem;
            self.publish(&runtime.status);
        }
    }

    pub(super) fn read_user_config(&self) -> CommandResult<UserConfig> {
        let home = self
            .home
            .as_deref()
            .ok_or_else(CommandError::open_ssh_home_unavailable)?;
        Ok(read_user_config(
            home,
            &ParseContext {
                local_user: local_username(),
            },
        )?)
    }

    fn read_back(hosts: &HostsState, startup: bool, approval: Option<u64>) -> CommandResult<()> {
        let sync = hosts.open_ssh();
        let request = {
            let mut runtime = sync.runtime.lock().unwrap_or_else(|p| p.into_inner());
            if !runtime.status.enabled {
                return if approval.is_some() {
                    Err(CommandError::open_ssh_read_changed())
                } else {
                    Ok(())
                };
            }
            runtime.read_request += 1;
            runtime.read_request
        };
        // Parse outside both locks. Later reads and disabling sync invalidate
        // this snapshot before it can change the HostStore.
        let user = sync.read_user_config();
        hosts.edit(|store| sync.finish_read(store, request, startup, approval, user))
    }

    fn finish_read(
        &self,
        store: &mut HostStore,
        request: u64,
        startup: bool,
        approval: Option<u64>,
        user: CommandResult<UserConfig>,
    ) -> CommandResult<()> {
        let mut runtime = self.runtime.lock().unwrap_or_else(|p| p.into_inner());
        if !runtime.status.enabled || runtime.read_request != request {
            return if approval.is_some() {
                Err(CommandError::open_ssh_read_changed())
            } else {
                Ok(())
            };
        }
        if let Some(approval) = approval {
            if runtime.status.read_approval != Some(approval)
                || user.as_ref().ok() != runtime.read_snapshot.as_ref()
            {
                return Err(CommandError::open_ssh_read_changed());
            }
        }
        let result = user.as_ref().map_err(Clone::clone).and_then(|user| {
            if let Some(reviewed) = runtime.status.read.as_ref().filter(|_| approval.is_some()) {
                store
                    .import_open_ssh_offered(user, reviewed)?
                    .ok_or_else(CommandError::open_ssh_read_changed)
            } else {
                Ok(store.sync_open_ssh(user)?)
            }
        });
        let (report, read_problem) = match result {
            Ok(report) => (Some(report), false),
            Err(error) if approval.is_some() => return Err(error),
            Err(_) => (None, true),
        };
        let offered = report
            .as_ref()
            .is_some_and(|report| !report.available.is_empty() || !report.dependencies.is_empty());
        runtime.status.read = report;
        runtime.status.read_problem = read_problem;
        runtime.status.read_approval = offered.then_some(request);
        runtime.status.startup_offer = (startup || runtime.status.startup_offer) && offered;
        runtime.read_snapshot = user.ok().filter(|_| offered);
        self.publish(&runtime.status);
        Ok(())
    }

    pub async fn wait_for_startup(&self) {
        let _ = self.startup_done.subscribe().wait_for(|done| *done).await;
    }

    pub fn sync_at_startup(hosts: HostsState) {
        if *hosts.open_ssh().startup_done.borrow() {
            return;
        }
        let done = hosts.open_ssh().startup_done.clone();
        tauri::async_runtime::spawn(async move {
            let result =
                tauri::async_runtime::spawn_blocking(move || Self::read_back(&hosts, true, None))
                    .await;
            if !matches!(result, Ok(Ok(()))) {
                log::warn!("Could not sync the OpenSSH config at startup");
            }
            done.send_replace(true);
        });
    }
}

#[tauri::command]
pub fn ssh_config_export_preview(
    window: WebviewWindow,
    hosts: State<'_, HostsState>,
) -> CommandResult<OpenSshPreview> {
    hosts.open_ssh().preview(window.label())
}

#[tauri::command]
pub fn ssh_config_export_cancel(window: WebviewWindow, hosts: State<'_, HostsState>) {
    hosts.open_ssh().forget_preview(window.label());
}

#[tauri::command]
pub fn ssh_config_export_enable(
    window: WebviewWindow,
    hosts: State<'_, HostsState>,
    settings: State<'_, SettingsState>,
    approval: u64,
) -> CommandResult<SettingsChange> {
    let change = settings.with(|settings| {
        hosts.with(|store| {
            hosts
                .open_ssh()
                .enable(window.label(), approval, store.list(), settings)
        })
    })?;
    let hosts = hosts.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = OpenSshSync::read_back(&hosts, false, None);
    });
    Ok(change)
}

#[tauri::command]
pub fn ssh_config_export_disable(
    hosts: State<'_, HostsState>,
    settings: State<'_, SettingsState>,
) -> CommandResult<SettingsChange> {
    settings
        .with(|settings| hosts.with_export_hosts(|list| hosts.open_ssh().disable(list, settings)))
}

#[tauri::command]
pub async fn ssh_config_export_refresh(hosts: State<'_, HostsState>) -> CommandResult<()> {
    hosts.open_ssh().wait_for_startup().await;
    let hosts = hosts.inner().clone();
    tauri::async_runtime::spawn_blocking(move || OpenSshSync::read_back(&hosts, false, None))
        .await
        .map_err(std::io::Error::other)?
}

#[tauri::command]
pub async fn ssh_config_sync_import(
    hosts: State<'_, HostsState>,
    approval: u64,
) -> CommandResult<()> {
    hosts.open_ssh().wait_for_startup().await;
    let hosts = hosts.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        OpenSshSync::read_back(&hosts, false, Some(approval))
    })
    .await
    .map_err(std::io::Error::other)?
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn read_back_respects_opt_in_and_requires_a_current_import_review() {
        let home = tempfile::tempdir().unwrap();
        let ssh = home.path().join(".ssh");
        fs::create_dir(&ssh).unwrap();
        let config = ssh.join("config");
        fs::write(&config, format!("{INCLUDE_LINE}\nHost first\n")).unwrap();
        let mut settings = SettingsStore::open(home.path().join("settings.json")).unwrap();
        let sync = OpenSshSync::new(
            Some(home.path().to_owned()),
            OpenSshSettings::default(),
            ConnectionSettings::default(),
            Arc::default(),
        );
        let path = home.path().join("hosts.json");
        let hosts = HostsState::new(Ok(HostStore::open(&path).unwrap()), sync);
        let sync = hosts.open_ssh();
        OpenSshSync::read_back(&hosts, true, None).unwrap();
        assert!(!ssh.join("ssh-astra.conf").exists());
        sync.with_status(|status| assert!(status.read.is_none()));

        let preview = sync.preview("test").unwrap();
        sync.enable("test", preview.approval, &[], &mut settings)
            .unwrap();
        OpenSshSync::read_back(&hosts, true, None).unwrap();
        let token = sync.with_status(|status| {
            assert!(status.startup_offer);
            assert_eq!(status.read.as_ref().unwrap().available, ["first"]);
            status.read_approval.unwrap()
        });
        assert!(!path.exists());

        fs::write(&config, format!("{INCLUDE_LINE}\nHost second\n")).unwrap();
        assert!(OpenSshSync::read_back(&hosts, false, Some(token)).is_err());
        assert!(!path.exists());
        OpenSshSync::read_back(&hosts, false, None).unwrap();
        let token = sync.with_status(|status| {
            assert_eq!(status.read.as_ref().unwrap().available, ["second"]);
            status.read_approval.unwrap()
        });
        OpenSshSync::read_back(&hosts, false, Some(token)).unwrap();
        assert_eq!(HostStore::open(&path).unwrap().list()[0].name, "second");
        assert!(OpenSshSync::read_back(&hosts, false, Some(token)).is_err());
        assert_eq!(
            fs::read_to_string(config).unwrap(),
            format!("{INCLUDE_LINE}\nHost second\n")
        );
    }

    #[test]
    fn approvals_belong_to_the_window_and_enable_once() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_owned();
        let mut settings = SettingsStore::open(home.join("settings.json")).unwrap();
        let sync = OpenSshSync::new(
            Some(home.clone()),
            OpenSshSettings::default(),
            ConnectionSettings::default(),
            Arc::default(),
        );

        let cancelled = sync.preview("first").unwrap();
        sync.forget_preview("first");
        assert!(sync
            .enable("first", cancelled.approval, &[], &mut settings)
            .is_err());
        let pending = sync.preview("first").unwrap();
        assert!(sync
            .enable("second", pending.approval, &[], &mut settings)
            .is_err());
        assert!(!home.join(".ssh").exists());
        assert!(!home.join("settings.json").exists());

        sync.enable("first", pending.approval, &[], &mut settings)
            .unwrap();
        sync.with_status(|status| assert!(status.enabled));
        assert!(
            settings
                .section::<OpenSshSettings>(OpenSshSettings::SECTION)
                .enabled
        );
        assert!(sync
            .enable("first", pending.approval, &[], &mut settings)
            .is_err());
        let config = home.join(".ssh/config");
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            format!("{INCLUDE_LINE}\n")
        );

        sync.disable(Some(&[]), &mut settings).unwrap();
        sync.with_status(|status| {
            assert!(!status.enabled);
            assert_eq!(status.include_line, Some(INCLUDE_LINE));
        });
        assert_eq!(
            fs::read_to_string(config).unwrap(),
            format!("{INCLUDE_LINE}\n")
        );
    }
}
