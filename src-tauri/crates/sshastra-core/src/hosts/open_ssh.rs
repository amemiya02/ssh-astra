//! Read-back from the user's OpenSSH config. The last parsed values let us
//! distinguish upstream edits from edits made inside SSH Astra.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::{chain, Host, HostAuth, HostId, HostStore, HostStoreError, ImportReport, ImportedProxyCommand, Library};
use crate::forward::{ForwardId, PortForward};
use crate::host_import::{ConfigHost, ImportIssue, ImportProblem, ParsedConfig};
use crate::proxy::HostProxy;
use crate::ssh_config::UserConfig;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSshSource {
    pub alias: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
    previous: ConfigHost,
    forward_ids: Vec<ForwardId>,
}

impl OpenSshSource {
    pub(super) fn new(entry: ConfigHost, forwards: &[PortForward]) -> Self {
        Self {
            alias: entry.name.clone(),
            missing: false,
            previous: entry,
            forward_ids: forwards.iter().map(|forward| forward.id.clone()).collect(),
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct OpenSshDiff {
    pub new: Vec<String>,
    pub changed: Vec<String>,
    pub deleted: Vec<String>,
}

fn key(alias: &str) -> String {
    alias.to_ascii_lowercase()
}

pub(super) fn source_ids(hosts: &[Host]) -> HashMap<String, HostId> {
    hosts.iter().filter_map(|host| {
        Some((key(&host.open_ssh_source.as_ref()?.alias), host.id.clone()))
    }).collect()
}

fn entries(user: &UserConfig) -> HashMap<String, &ConfigHost> {
    user.parsed.hosts.iter().map(|entry| (key(&entry.name), entry)).collect()
}

fn complete(user: &UserConfig) -> bool {
    !user.parsed.issues.iter().any(|issue| matches!(issue.problem, ImportProblem::IncludeFailed { .. }))
}

/// Compares a complete parsed snapshot to each Host's last seen source values.
/// An alias that still exists but cannot be parsed is not deleted.
pub fn diff_open_ssh(hosts: &[Host], user: &UserConfig) -> OpenSshDiff {
    let mut diff = OpenSshDiff::default();
    if !complete(user) {
        return diff;
    }

    let entries = entries(user);
    let source_ids = source_ids(hosts);
    let mut declared = HashSet::new();
    let names: HashSet<_> = hosts.iter().map(|host| host.name.as_str()).collect();
    for alias in &user.aliases {
        let identity = key(alias);
        if !source_ids.contains_key(&identity)
            && !names.contains(alias.as_str())
            && entries.contains_key(&identity)
            && !declared.contains(&identity)
        {
            diff.new.push(alias.clone());
        }
        declared.insert(identity);
    }
    // A parsed hop with an invalid directive can appear only in an issue.
    let dropped: HashSet<_> = user.parsed.issues.iter().filter(|issue| issue.dropped).map(|issue| key(&issue.entry)).collect();
    for source in hosts.iter().filter_map(|host| host.open_ssh_source.as_ref()) {
        let identity = key(&source.alias);
        match entries.get(&identity) {
            Some(entry) if source.missing || &source.previous != *entry => diff.changed.push(source.alias.clone()),
            None if !source.missing && !declared.contains(&identity) && !dropped.contains(&identity) => {
                diff.deleted.push(source.alias.clone());
            }
            _ => {}
        }
    }
    diff
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSshReadReport {
    pub available: Vec<String>,
    pub dependencies: Vec<String>,
    pub imported: Vec<String>,
    pub updated: Vec<String>,
    pub missing: Vec<String>,
    pub awaiting_jump: Vec<String>,
    pub issues: Vec<ImportIssue>,
    pub proxy_commands: Vec<ImportedProxyCommand>,
}

impl HostStore {
    /// Explicit import from the user's OpenSSH config, linking each newly saved Host.
    pub fn import_open_ssh(&mut self, user: UserConfig) -> Result<ImportReport, HostStoreError> {
        let mut library = self.library.clone();
        let report = Self::add_config(&mut library, user.parsed, true)?;
        if !report.imported.is_empty() {
            self.save(library)?;
        }
        Ok(report)
    }

    /// Updates existing linked Hosts and marks missing sources without removing them.
    pub fn sync_open_ssh(&mut self, user: &UserConfig) -> Result<OpenSshReadReport, HostStoreError> {
        let (library, report) = self.plan_open_ssh(user, None)?;
        if library.hosts != self.library.hosts {
            self.save(library)?;
        }
        Ok(report)
    }

    /// Accepts the offered aliases and any new Jump hosts they depend on.
    pub fn import_open_ssh_offered(
        &mut self,
        user: &UserConfig,
        reviewed: &OpenSshReadReport,
    ) -> Result<Option<OpenSshReadReport>, HostStoreError> {
        let (library, report) = self.plan_open_ssh(user, Some(reviewed))?;
        if report.available != reviewed.available || report.dependencies != reviewed.dependencies {
            return Ok(None);
        }
        if library.hosts != self.library.hosts {
            self.save(library)?;
        }
        Ok(Some(OpenSshReadReport {
            available: Vec::new(),
            dependencies: Vec::new(),
            proxy_commands: Vec::new(),
            ..report
        }))
    }

    fn plan_open_ssh(
        &self,
        user: &UserConfig,
        reviewed: Option<&OpenSshReadReport>,
    ) -> Result<(Library, OpenSshReadReport), HostStoreError> {
        let mut library = self.library.clone();
        let diff = diff_open_ssh(&library.hosts, user);
        let offered = offered_config(&library, user, &diff);
        let mut report = OpenSshReadReport {
            available: diff.new.clone(),
            dependencies: offered.iter().filter(|entry| !diff.new.contains(&entry.name)).map(|entry| entry.name.clone()).collect(),
            issues: user.parsed.issues.clone(),
            ..OpenSshReadReport::default()
        };
        report.proxy_commands = offered.iter().filter_map(|entry| {
            Some(ImportedProxyCommand { host: entry.name.clone(), command: entry.proxy_command.clone()? })
        }).collect();

        if let Some(reviewed) = reviewed {
            if report.available != reviewed.available || report.dependencies != reviewed.dependencies {
                return Ok((library, report));
            }
            if !offered.is_empty() {
                report.imported = Self::add_config(&mut library, ParsedConfig { hosts: offered, issues: Vec::new() }, true)?.imported;
            }
        }

        let entries = entries(user);
        let sources = source_ids(&library.hosts);
        let names: HashMap<_, _> = library.hosts.iter().map(|host| (host.name.clone(), host.id.clone())).collect();
        let mut updated = Vec::new();
        for host in &mut library.hosts {
            let Some(mut source) = host.open_ssh_source.take() else { continue };
            if diff.deleted.contains(&source.alias) {
                source.missing = true;
            }
            if diff.changed.contains(&source.alias) {
                let entry = entries[&key(&source.alias)];
                let jump = entry.jump_host.as_ref().and_then(|name| sources.get(&key(name)).or_else(|| names.get(name)));
                if entry.jump_host.is_some() && jump.is_none() {
                    report.awaiting_jump.push(source.alias.clone());
                } else {
                    update_config(host, &mut source, entry, jump.cloned())?;
                    updated.push(host.id.clone());
                    report.updated.push(source.alias.clone());
                }
            }
            if source.missing {
                report.missing.push(source.alias.clone());
            }
            host.open_ssh_source = Some(source);
        }
        for host in updated {
            chain(&library.hosts, &host)?;
        }
        Ok((library, report))
    }
}

/// Follow the offered aliases' routes to include their dependencies. Also
/// offer a new implicit hop needed by an already linked alias.
fn offered_config(library: &Library, user: &UserConfig, diff: &OpenSshDiff) -> Vec<ConfigHost> {
    let sources = source_ids(&library.hosts);
    let names: HashSet<_> = library.hosts.iter().map(|host| host.name.as_str()).collect();
    let entries = entries(user);
    let mut offered = HashSet::new();
    for alias in &diff.new {
        collect_dependencies(alias, &entries, &sources, &names, &mut offered);
    }
    for alias in &diff.changed {
        if let Some(jump) = entries[&key(alias)].jump_host.as_deref() {
            collect_dependencies(jump, &entries, &sources, &names, &mut offered);
        }
    }
    user.parsed.hosts.iter().filter(|entry| offered.contains(&key(&entry.name))).cloned().collect()
}

fn collect_dependencies(
    alias: &str,
    entries: &HashMap<String, &ConfigHost>,
    sources: &HashMap<String, HostId>,
    names: &HashSet<&str>,
    offered: &mut HashSet<String>,
) {
    let mut entry = entries.get(&key(alias));
    while let Some(current) = entry {
        let identity = key(&current.name);
        if sources.contains_key(&identity) || names.contains(current.name.as_str()) || !offered.insert(identity) {
            break;
        }
        entry = current.jump_host.as_ref().and_then(|jump| entries.get(&key(jump)));
    }
}

pub(super) fn config_auth(identity_file: Option<PathBuf>) -> HostAuth {
    match identity_file {
        Some(identity_file) => HostAuth::Key { identity_file },
        None => HostAuth::Auto,
    }
}

fn update_config(
    host: &mut Host,
    source: &mut OpenSshSource,
    config: &ConfigHost,
    jump: Option<HostId>,
) -> Result<(), HostStoreError> {
    let previous = &source.previous;
    if previous.address != config.address {
        host.address = config.address.trim().to_owned();
        if host.address.is_empty() {
            return Err(HostStoreError::Invalid("address"));
        }
    }
    if previous.port != config.port {
        host.port = config.port;
    }
    if previous.user != config.user {
        host.user = config.user.trim().to_owned();
        if host.user.is_empty() {
            return Err(HostStoreError::Invalid("user"));
        }
    }
    if previous.identity_file != config.identity_file {
        host.auth = config_auth(config.identity_file.clone());
    }
    if previous.identities_only != config.identities_only {
        host.identities_only = config.identities_only;
    }
    if previous.forward_agent != config.forward_agent {
        host.forward_agent = config.forward_agent;
    }
    if previous.keepalive_seconds != config.keepalive_seconds {
        host.keepalive_seconds = config.keepalive_seconds;
    }
    if previous.proxy_command != config.proxy_command {
        host.proxy = config.proxy_command.clone().map(HostProxy::ProxyCommand).unwrap_or_default();
    }
    if previous.jump_host != config.jump_host {
        host.jump_host = jump;
    }
    if previous.forwards != config.forwards {
        let mut ids = Vec::new();
        let mut retained = HashSet::new();
        let mut added = Vec::new();
        for draft in &config.forwards {
            let same = previous.forwards.iter().zip(&source.forward_ids).find_map(|(old, id)| {
                (old == draft && retained.insert(id.clone())).then(|| id.clone())
            });
            let id = match same {
                Some(id) => id,
                None => {
                    let id = ForwardId::generate();
                    added.push(draft.clone().into_forward(id.clone()).map_err(HostStoreError::Invalid)?);
                    id
                }
            };
            ids.push(id);
        }
        host.forwards.retain(|forward| !source.forward_ids.contains(&forward.id) || retained.contains(&forward.id));
        host.forwards.extend(added);
        source.forward_ids = ids;
    }
    source.missing = false;
    source.previous = config.clone();
    Ok(())
}
