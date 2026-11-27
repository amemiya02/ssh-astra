use std::borrow::Cow;
use std::collections::HashSet;
use std::net::Ipv6Addr;
use std::path::PathBuf;

use encoding_rs::{Encoding, WINDOWS_1252};

use super::{ConfigHost, ImportIssue, ImportProblem, ParsedConfig};

const GATEWAY_SEPARATOR: &str = "__PIPE__";

/// Reads SSH bookmarks from a MobaXterm session export. The export contains
/// only the selected folders, or one bare session line for a .moba export.
/// A session without a saved username uses the supplied local username.
pub fn parse_mobaxterm(bytes: &[u8], local_user: &str) -> ParsedConfig {
    let Some(text) = decode(bytes) else {
        return invalid_file(1);
    };
    let mut lines = text
        .lines()
        .enumerate()
        .map(|(index, text)| (index + 1, text.trim()))
        .filter(|&(_, text)| !text.is_empty() && !text.starts_with([';', '#']));

    let mut parsed = ParsedConfig::default();
    let mut sessions = Vec::new();
    if lines.clone().any(|(_, text)| section_name(text).is_some()) {
        let mut found_bookmarks = false;
        let mut section = None;
        for (line, text) in lines {
            if let Some(name) = section_name(text) {
                if let Some(rows) = section.take() {
                    parse_section(rows, local_user, &mut sessions, &mut parsed.issues);
                }
                if bookmark_section(name) {
                    found_bookmarks = true;
                    section = Some(Vec::new());
                }
            } else if let Some(rows) = &mut section {
                rows.push((line, text));
            }
        }
        if let Some(rows) = section {
            parse_section(rows, local_user, &mut sessions, &mut parsed.issues);
        }
        if !found_bookmarks {
            return invalid_file(1);
        }
    } else {
        if let Some((line, text)) = lines.next() {
            if lines.next().is_some() {
                return invalid_file(line);
            }
            parse_row(
                line,
                text,
                Some(&[]),
                local_user,
                &mut sessions,
                &mut parsed.issues,
            );
        }
    }
    parsed.hosts = link_gateways(sessions);
    parsed
}

fn decode(bytes: &[u8]) -> Option<Cow<'_, str>> {
    if let Some((encoding, bom_length)) = Encoding::for_bom(bytes) {
        let (text, malformed) = encoding.decode_without_bom_handling(&bytes[bom_length..]);
        return (!malformed).then_some(text);
    }
    Some(match std::str::from_utf8(bytes) {
        Ok(text) => text.into(),
        Err(_) => WINDOWS_1252.decode_without_bom_handling(bytes).0,
    })
}

fn section_name(text: &str) -> Option<&str> {
    text.strip_prefix('[')?.strip_suffix(']')
}

fn bookmark_section(name: &str) -> bool {
    name.eq_ignore_ascii_case("Bookmarks")
        || name.split_once('_').is_some_and(|(name, suffix)| {
            name.eq_ignore_ascii_case("Bookmarks")
                && !suffix.is_empty()
                && suffix.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn parse_section(
    rows: Vec<(usize, &str)>,
    local_user: &str,
    sessions: &mut Vec<Session>,
    issues: &mut Vec<ImportIssue>,
) {
    let group = rows
        .iter()
        .filter_map(|(_, row)| row.split_once('='))
        .find(|(key, _)| key.trim().eq_ignore_ascii_case("SubRep"))
        .map_or_else(|| Some(Vec::new()), |(_, value)| group_path(value.trim()));
    for (line, row) in rows {
        if row.split_once('=').is_some_and(|(key, _)| {
            key.trim().eq_ignore_ascii_case("SubRep") || key.trim().eq_ignore_ascii_case("ImgNum")
        }) {
            continue;
        }
        parse_row(line, row, group.as_deref(), local_user, sessions, issues);
    }
}

fn group_path(value: &str) -> Option<Vec<String>> {
    if value.is_empty() {
        return Some(Vec::new());
    }
    value
        .split('\\')
        .map(str::trim)
        .map(|part| valid_label(part).then(|| part.to_owned()))
        .collect()
}

fn parse_row(
    line: usize,
    text: &str,
    group: Option<&[String]>,
    local_user: &str,
    sessions: &mut Vec<Session>,
    issues: &mut Vec<ImportIssue>,
) {
    match Session::read(text, group, local_user) {
        Ok((session, unsupported_settings)) => {
            let mut endpoints = std::iter::once(&session.target).chain(&session.gateways);
            if endpoints.clone().any(|endpoint| endpoint.default_user) {
                issues.push(issue(line, false, ImportProblem::MobaxtermDefaultUser));
            }
            if endpoints.any(|endpoint| endpoint.unmapped_key) {
                issues.push(issue(line, false, ImportProblem::MobaxtermKeyPath));
            }
            if unsupported_settings {
                issues.push(issue(
                    line,
                    false,
                    ImportProblem::MobaxtermUnsupportedSettings,
                ));
            }
            sessions.push(session);
        }
        Err(problem) => issues.push(issue(line, true, problem)),
    }
}

fn issue(line: usize, dropped: bool, problem: ImportProblem) -> ImportIssue {
    ImportIssue {
        entry: String::new(),
        line: Some(line),
        dropped,
        problem,
    }
}

fn invalid_file(line: usize) -> ParsedConfig {
    ParsedConfig {
        hosts: Vec::new(),
        issues: vec![issue(line, true, ImportProblem::MobaxtermFile)],
    }
}

struct Session {
    name: String,
    group: Vec<String>,
    target: Endpoint,
    gateways: Vec<Endpoint>,
}

impl Session {
    fn read(
        text: &str,
        group: Option<&[String]>,
        local_user: &str,
    ) -> Result<(Self, bool), ImportProblem> {
        // Positional SSH fields were established by comparing exported sessions:
        // https://gist.github.com/Ruzgfpegk/ab597838e4abbe8de30d7224afd062ea
        let (name, value) = text
            .split_once('=')
            .ok_or(ImportProblem::MobaxtermSession)?;
        let name = name.trim();
        let mut blocks = value.trim_start().split('#');
        let prefix = blocks.next().unwrap_or_default().trim();
        let icon = blocks.next().ok_or(ImportProblem::MobaxtermSession)?;
        if !valid_label(name)
            || !prefix.is_empty() && prefix.strip_prefix(';').map(str::trim) != Some("logout")
            || icon.is_empty()
            || !icon.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(ImportProblem::MobaxtermSession);
        }
        let fields: Vec<_> = blocks
            .next()
            .ok_or(ImportProblem::MobaxtermSession)?
            .split('%')
            .collect();
        match field(&fields, 0) {
            "0" => {}
            kind if !kind.is_empty() && kind.bytes().all(|byte| byte.is_ascii_digit()) => {
                return Err(ImportProblem::MobaxtermUnsupportedSession);
            }
            _ => return Err(ImportProblem::MobaxtermSession),
        }
        let group = group.ok_or(ImportProblem::MobaxtermInvalidGroup)?;
        let username = if field(&fields, 12) == "-1" {
            ""
        } else {
            field(&fields, 3)
        };
        let target = Endpoint::read(
            field(&fields, 1),
            field(&fields, 2),
            username,
            field(&fields, 14),
            local_user,
        )?;
        let gateways = parse_gateways(&fields, local_user)?;
        // Commands, proxies, and other unsupported fields can contain
        // credentials. Keep only the fact that some settings were skipped.
        let unsupported_settings = has_unsupported_ssh_settings(&fields)
            || blocks.any(|value| !matches!(value.trim(), "" | "0" | "-1"));
        Ok((
            Self {
                name: name.to_owned(),
                group: group.to_vec(),
                target,
                gateways,
            },
            unsupported_settings,
        ))
    }
}

fn field<'a>(fields: &[&'a str], index: usize) -> &'a str {
    fields.get(index).copied().unwrap_or_default().trim()
}

fn has_unsupported_ssh_settings(fields: &[&str]) -> bool {
    fields.iter().enumerate().any(|(index, value)| {
        let value = value.trim();
        if value.is_empty() {
            return false;
        }
        match index {
            // Session type, destination, gateway lists, and key references.
            0..=3 | 8..=10 | 12 | 14 | 15 => false,
            // Disabled features and the serialized defaults for unused options.
            5 | 6 | 11 | 13 | 18 | 19 | 23 | 24 | 27 | 31 | 34 | 37 => value != "0",
            16 | 17 | 32 | 33 => value != "-1",
            21 => value != "1080",
            25 => value != "1",
            _ => true,
        }
    })
}

struct Endpoint {
    address: String,
    port: u16,
    user: String,
    identity_file: Option<PathBuf>,
    default_user: bool,
    unmapped_key: bool,
}

impl Endpoint {
    fn read(
        address: &str,
        port: &str,
        user: &str,
        key: &str,
        local_user: &str,
    ) -> Result<Self, ImportProblem> {
        let address = ssh_address(address).ok_or(ImportProblem::MobaxtermSession)?;
        let port = if port.is_empty() {
            22
        } else {
            port.parse::<u16>()
                .ok()
                .filter(|&port_number| {
                    port_number > 0 && port.bytes().all(|byte| byte.is_ascii_digit())
                })
                .ok_or(ImportProblem::MobaxtermInvalidPort)?
        };
        let default_user = user.is_empty() || user.eq_ignore_ascii_case("<default>");
        let user = if default_user {
            local_user.trim()
        } else {
            user
        };
        if !valid_label(user) || user.contains(':') {
            return Err(ImportProblem::MobaxtermSession);
        }
        let identity_file = identity_file(key);
        Ok(Self {
            address: address.to_owned(),
            port,
            user: user.to_owned(),
            unmapped_key: !key.is_empty() && identity_file.is_none(),
            identity_file,
            default_user,
        })
    }

    fn host(self, name: String, group_path: Vec<String>, jump_host: Option<String>) -> ConfigHost {
        ConfigHost {
            name,
            address: self.address,
            port: self.port,
            user: self.user,
            identity_file: self.identity_file,
            identities_only: false,
            forward_agent: false,
            keepalive_seconds: None,
            jump_host,
            proxy_command: None,
            forwards: Vec::new(),
            group_path,
        }
    }
}

fn valid_label(value: &str) -> bool {
    !value.is_empty() && !value.chars().any(char::is_control)
}

fn ssh_address(value: &str) -> Option<&str> {
    let host = value
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(value);
    if host.contains(':') {
        return host.parse::<Ipv6Addr>().is_ok().then_some(host);
    }
    let valid = value == host
        && !host.is_empty()
        && host
            .chars()
            .all(|ch| ch.is_alphanumeric() || matches!(ch, '.' | '-' | '_'));
    valid.then_some(host)
}

fn identity_file(value: &str) -> Option<PathBuf> {
    if !valid_label(value) || value.contains("://") {
        return None;
    }
    if let Some(home_path) = value.strip_prefix("_ProfileDir_") {
        let relative = home_path.strip_prefix(['\\', '/'])?;
        return (!relative.is_empty())
            .then(|| PathBuf::from(format!("~/{}", relative.replace('\\', "/"))));
    }
    // These placeholders depend on the original Windows installation.
    if ["_CurrentDrive_", "_MyDocuments_", "_AppDataDir_"]
        .iter()
        .any(|prefix| value.starts_with(prefix))
    {
        return None;
    }
    Some(PathBuf::from(value))
}

fn parse_gateways(fields: &[&str], local_user: &str) -> Result<Vec<Endpoint>, ImportProblem> {
    let hosts = field(fields, 8);
    let ports = field(fields, 9);
    let users = field(fields, 10);
    let keys = field(fields, 15);
    if hosts.is_empty() {
        return if [ports, users, keys].iter().all(|value| value.is_empty()) {
            Ok(Vec::new())
        } else {
            Err(ImportProblem::MobaxtermInvalidGateway)
        };
    }
    let hosts: Vec<_> = hosts.split(GATEWAY_SEPARATOR).map(str::trim).collect();
    let ports = gateway_list(ports, hosts.len())?;
    let users = gateway_list(users, hosts.len())?;
    let keys = gateway_list(keys, hosts.len())?;
    hosts
        .into_iter()
        .zip(ports)
        .zip(users)
        .zip(keys)
        .map(|(((host, port), user), key)| {
            Endpoint::read(host, port, user, key, local_user)
                .map_err(|_| ImportProblem::MobaxtermInvalidGateway)
        })
        .collect()
}

fn gateway_list(value: &str, count: usize) -> Result<Vec<&str>, ImportProblem> {
    if value.is_empty() {
        return Ok(vec![""; count]);
    }
    let list: Vec<_> = value.split(GATEWAY_SEPARATOR).map(str::trim).collect();
    (list.len() == count)
        .then_some(list)
        .ok_or(ImportProblem::MobaxtermInvalidGateway)
}

fn link_gateways(sessions: Vec<Session>) -> Vec<ConfigHost> {
    let mut hosts = Vec::new();
    let mut names: HashSet<_> = sessions
        .iter()
        .map(|session| session.name.clone())
        .collect();
    let mut seen = HashSet::new();
    for Session {
        name,
        group,
        target,
        gateways,
    } in sessions
    {
        let mut jump_host = None;
        let mut jumps = Vec::new();
        // HostStore keeps the first Host of a given name. Only that session
        // needs its generated gateways.
        if seen.insert(name.clone()) {
            for gateway in gateways {
                let address = if gateway.address.contains(':') {
                    format!("[{}]", gateway.address)
                } else {
                    gateway.address.clone()
                };
                let base = format!("{name} / {}@{address}:{}", gateway.user, gateway.port);
                let mut gateway_name = base.clone();
                let mut suffix = 2;
                while !names.insert(gateway_name.clone()) {
                    gateway_name = format!("{base} ({suffix})");
                    suffix += 1;
                }
                let hop = gateway.host(gateway_name.clone(), group.clone(), jump_host);
                jump_host = Some(gateway_name);
                jumps.push(hop);
            }
        }
        hosts.push(target.host(name, group, jump_host));
        hosts.extend(jumps);
    }
    hosts
}
