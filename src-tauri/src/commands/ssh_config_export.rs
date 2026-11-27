//! Approval and status for the shared OpenSSH export setting.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::json;
use sshastra_core::hosts::Host;
use sshastra_core::settings::SettingsStore;
use sshastra_core::ssh::ConnectionSettings;
use sshastra_core::ssh_config_export::{
    ConfigExport, ExportError, ExportReport, IncludePlan, INCLUDE_LINE,
};
use tauri::{State, WebviewWindow};

use super::hosts::HostsState;
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
}

struct Runtime {
    status: OpenSshStatus,
    connection: ConnectionSettings,
    previews: HashMap<String, (u64, IncludePlan)>,
    next_preview: u64,
}

pub struct OpenSshSync {
    export: Option<ConfigExport>,
    runtime: Mutex<Runtime>,
    changes: Arc<SettingsChanges>,
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
            export: home.map(ConfigExport::new),
            runtime: Mutex::new(Runtime {
                status: OpenSshStatus {
                    enabled: preferences.enabled,
                    include_line: preferences.enabled.then_some(INCLUDE_LINE),
                    ..Default::default()
                },
                connection,
                previews: HashMap::new(),
                next_preview: 0,
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
            problem: None,
            include_line: Some(INCLUDE_LINE),
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
        let status = OpenSshStatus {
            enabled: true,
            report,
            problem,
            include_line: Some(INCLUDE_LINE),
        };
        if runtime.status != status {
            runtime.status = status;
            self.publish(&runtime.status);
        }
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
    settings.with(|settings| {
        hosts.with(|store| {
            hosts
                .open_ssh()
                .enable(window.label(), approval, store.list(), settings)
        })
    })
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
pub fn ssh_config_export_refresh(hosts: State<'_, HostsState>) -> CommandResult<()> {
    hosts.with(|store| {
        hosts.open_ssh().rebuild(store.list(), None);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

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
