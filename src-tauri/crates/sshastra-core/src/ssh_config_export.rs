//! Writes saved Hosts to an SSH Astra-managed OpenSSH config fragment.

mod install;

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::forward::ForwardKind;
use crate::hosts::{Host, HostAuth};
use crate::proxy::{endpoint_host, HostProxy};
use crate::ssh::ConnectionSettings;
use crate::wildcard;

pub use install::{ConfigExport, ExportError, IncludePlan, INCLUDE_LINE};

pub(crate) const HEADER: &str = "# Managed by SSH Astra.\n";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct UserAliases(Vec<Vec<String>>);

impl UserAliases {
    pub fn new(blocks: Vec<Vec<String>>) -> Self {
        Self(blocks)
    }

    fn has_literal(&self, alias: &str) -> bool {
        self.0.iter().flatten().any(|pattern| pattern.eq_ignore_ascii_case(alias))
    }

    fn contains(&self, alias: &str) -> bool {
        self.0.iter().any(|patterns| {
            let mut specific = false;
            for pattern in patterns {
                let (negated, pattern) = match pattern.strip_prefix('!') {
                    Some(pattern) => (true, pattern),
                    None => (false, pattern.as_str()),
                };
                if wildcard::matches(
                    &pattern.to_ascii_lowercase().chars().collect::<Vec<_>>(),
                    alias,
                ) {
                    if negated {
                        return false;
                    }
                    // A bare wildcard provides defaults for aliases, including ours.
                    specific |= pattern != "*";
                }
            }
            specific
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportIssue {
    UserAlias,
    DuplicateAlias,
    InvalidField,
    UnsupportedProxy,
    JumpUnavailable,
    HttpForward,
    ManualForward,
    InvalidForward,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExportNote {
    pub host: String,
    pub alias: String,
    pub reason: ExportIssue,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct ExportReport {
    pub aliases: Vec<String>,
    pub issues: Vec<ExportNote>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct GeneratedConfig {
    pub text: String,
    pub report: ExportReport,
}

/// A stable CLI-safe alias. A name with no ASCII letters or digits gets a
/// deterministic alias that is independent of the Host list's order.
fn alias(name: &str) -> String {
    let mut result = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            result.push(c.to_ascii_lowercase());
        } else if result.ends_with(|last: char| last.is_ascii_alphanumeric()) {
            result.push(if matches!(c, '.' | '_') { c } else { '-' });
        }
    }
    if result.ends_with(['.', '_', '-']) {
        result.pop();
    }
    if result.is_empty() {
        let digest = Sha256::digest(name.as_bytes());
        result.push_str("host-");
        for byte in &digest[..8] {
            let _ = write!(result, "{byte:02x}");
        }
    }
    if result == "none" {
        result = "ssh-none".into(); // ProxyJump reserves 'none'.
    }
    result
}

/// Generates a fragment without consulting the filesystem or expanding
/// credentials, executable directives, or user-supplied config text.
pub fn generate(
    hosts: &[Host],
    user_aliases: &UserAliases,
    settings: &ConnectionSettings,
) -> GeneratedConfig {
    let mut named: Vec<_> = hosts
        .iter()
        .filter(|host| host.open_ssh_source.is_none())
        .map(|host| (alias(&host.name), host))
        .collect();
    named.sort_by(|(a, _), (b, _)| a.cmp(b));
    let mut seen = HashSet::new();
    let duplicates: HashSet<_> = named
        .iter()
        .filter_map(|(alias, _)| (!seen.insert(alias.as_str())).then_some(alias.as_str()))
        .collect();
    let mut report = ExportReport::default();
    let mut entries = HashMap::new();

    for (alias, host) in &named {
        let entry = if user_aliases.contains(alias) {
            Err(ExportIssue::UserAlias)
        } else if duplicates.contains(alias.as_str()) {
            Err(ExportIssue::DuplicateAlias)
        } else {
            host_entry(host, alias, settings)
        };
        match entry {
            Ok(entry) => {
                entries.insert(&host.id, (alias, host, entry));
            }
            Err(reason) => note(&mut report, host, alias, reason),
        }
    }

    let user_jumps: HashMap<_, _> = hosts.iter().filter_map(|host| {
        let source = host.open_ssh_source.as_ref()?;
        let name = source.alias.as_str();
        let safe = !name.is_empty() && !name.starts_with('-')
            && !name.eq_ignore_ascii_case("none")
            && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'));
        (safe && !source.missing && user_aliases.has_literal(name)).then_some((&host.id, name))
    }).collect();

    let mut text = HEADER.to_owned();
    for (alias, host) in &named {
        let Some((_, _, entry)) = entries.get(&host.id) else {
            continue;
        };
        // OpenSSH follows the Jump alias's own settings. A linked user alias
        // already has a declaration, so the user config supplies the rest of its route.
        let mut route = HashSet::from([&host.id]);
        let mut hop = host.jump_host.as_ref();
        let mut available = true;
        while let Some(id) = hop {
            match entries.get(id) {
                Some((_, host, _)) if route.insert(id) => hop = host.jump_host.as_ref(),
                None if user_jumps.contains_key(id) => break,
                _ => {
                    available = false;
                    break;
                }
            }
        }
        if !available {
            note(&mut report, host, alias, ExportIssue::JumpUnavailable);
            continue;
        }

        text.push_str(entry);
        if let Some(jump) = host.jump_host.as_ref() {
            let alias = user_jumps.get(jump).copied().unwrap_or_else(|| entries[jump].0);
            let _ = writeln!(text, "    ProxyJump {alias}");
        }
        for forward in &host.forwards {
            match forward_entry(&forward.kind, forward.auto_start) {
                Ok(line) => text.push_str(&line),
                Err(reason) => note(&mut report, host, alias, reason),
            }
        }
        report.aliases.push(alias.clone());
    }

    GeneratedConfig { text, report }
}

fn note(report: &mut ExportReport, host: &Host, alias: &str, reason: ExportIssue) {
    let note = ExportNote {
        host: host.name.clone(),
        alias: alias.to_owned(),
        reason,
    };
    if !report.issues.contains(&note) {
        report.issues.push(note);
    }
}

fn host_entry(
    host: &Host,
    alias: &str,
    settings: &ConnectionSettings,
) -> Result<String, ExportIssue> {
    if host.jump_host.is_none()
        && match host.proxy {
            HostProxy::Inherit => settings.proxy.is_some(),
            HostProxy::Direct => false,
            HostProxy::Override(_) | HostProxy::ProxyCommand(_) => true,
        }
    {
        return Err(ExportIssue::UnsupportedProxy);
    }
    let address = endpoint_host(&host.address).ok_or(ExportIssue::InvalidField)?;
    let keepalive = host.keepalive_seconds.unwrap_or(settings.keepalive_seconds);
    if host.port == 0
        || keepalive > i32::MAX as u32
        || address.starts_with('-')
        || host.user.is_empty()
        || host.user.starts_with('-')
        || !host
            .user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    {
        return Err(ExportIssue::InvalidField);
    }

    let yn = |value| if value { "yes" } else { "no" };
    let mut lines = format!(
        "\nHost {alias}\n    HostName {address}\n    Port {}\n    User {}\n    ServerAliveInterval {keepalive}\n    IdentitiesOnly {}\n    ForwardAgent {}\n",
        host.port, host.user, yn(host.identities_only), yn(host.forward_agent),
    );
    match &host.auth {
        HostAuth::Auto => {}
        HostAuth::Password => lines.push_str("    IdentityFile none\n"),
        HostAuth::Key { identity_file } => {
            let key = identity_file
                .to_str()
                .filter(|path| {
                    !path.is_empty()
                        && !path.chars().any(char::is_control)
                        && !path.contains("${")
                        && (!path.starts_with('~') || path.starts_with("~/"))
                })
                .ok_or(ExportIssue::InvalidField)?;
            let key = if key == "none" { "./none" } else { key };
            let _ = writeln!(
                lines,
                "    IdentityFile \"{}\"",
                key.replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('%', "%%")
            );
        }
    }
    Ok(lines)
}

fn endpoint(raw: &str, port: u16) -> Option<String> {
    if port == 0 {
        return None;
    }
    let address = endpoint_host(raw)?;
    Some(if address.contains(':') {
        format!("[{address}]:{port}")
    } else {
        format!("{address}:{port}")
    })
}

fn forward_entry(kind: &ForwardKind, auto_start: bool) -> Result<String, ExportIssue> {
    if matches!(kind, ForwardKind::Http { .. }) {
        return Err(ExportIssue::HttpForward);
    }
    // OpenSSH starts every rule in a config file when connecting.
    if !auto_start {
        return Err(ExportIssue::ManualForward);
    }
    let address = |raw, port| endpoint(raw, port).ok_or(ExportIssue::InvalidForward);
    Ok(match kind {
        ForwardKind::Local {
            bind_address,
            bind_port,
            remote_host,
            remote_port,
        } => {
            format!(
                "    LocalForward {} {}\n",
                address(bind_address, *bind_port)?,
                address(remote_host, *remote_port)?
            )
        }
        ForwardKind::Remote {
            bind_address,
            bind_port,
            local_host,
            local_port,
        } => {
            format!(
                "    RemoteForward {} {}\n",
                address(bind_address, *bind_port)?,
                address(local_host, *local_port)?
            )
        }
        ForwardKind::Dynamic {
            bind_address,
            bind_port,
        } => {
            format!(
                "    DynamicForward {}\n",
                address(bind_address, *bind_port)?
            )
        }
        ForwardKind::Http { .. } => unreachable!(),
    })
}
