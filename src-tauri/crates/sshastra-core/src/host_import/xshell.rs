use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path, PathBuf};

use super::{
    decode_windows_text, ssh_address, valid_label, ConfigHost, ImportIssue, ImportProblem,
    ParsedConfig,
};

/// Parses `.xsh` session files supplied as (relative path, contents). The
/// selected directory itself contributes no Group. No paths from the input
/// are opened, including references to keys, proxy profiles and sessions.
pub fn parse_xshell<'a>(
    files: impl IntoIterator<Item = (&'a Path, &'a [u8])>,
    local_user: &str,
) -> ParsedConfig {
    let mut parsed = ParsedConfig::default();
    let mut sessions = Vec::new();
    for (path, bytes) in files {
        let Some(parts) = session_path(path) else {
            parsed
                .issues
                .push(issue("", true, ImportProblem::XshellFile));
            continue;
        };
        let entry = parts.join("/");
        match parse_session(path, &parts[..parts.len() - 1], bytes, local_user) {
            Ok((host, gateway, problems)) => {
                parsed.issues.extend(
                    problems
                        .into_iter()
                        .map(|problem| issue(&entry, false, problem)),
                );
                sessions.push((host, gateway));
            }
            Err(problem) => parsed.issues.push(issue(&entry, true, problem)),
        }
    }

    // Avoid using the name of a destination session for a generated Jump host.
    let mut names: HashSet<_> = sessions.iter().map(|(host, _)| host.name.clone()).collect();
    for (mut host, gateway) in sessions {
        if let Some(gateway) = gateway {
            let base = format!("{} (Xshell Jump host)", host.name);
            let mut name = base.clone();
            let mut suffix = 2;
            while !names.insert(name.clone()) {
                name = format!("{base} {suffix}");
                suffix += 1;
            }
            host.jump_host = Some(name.clone());
            parsed
                .hosts
                .push(gateway.host(name, host.group_path.clone()));
        }
        parsed.hosts.push(host);
    }
    parsed
}

fn session_path(path: &Path) -> Option<Vec<&str>> {
    if !path.extension()?.to_str()?.eq_ignore_ascii_case("xsh") {
        return None;
    }
    path.components()
        .map(|component| {
            let Component::Normal(part) = component else {
                return None;
            };
            let part = part.to_str()?;
            (valid_label(part) && !part.trim().is_empty() && !part.contains(['\\', ':']))
                .then_some(part)
        })
        .collect()
}

fn issue(entry: &str, dropped: bool, problem: ImportProblem) -> ImportIssue {
    ImportIssue {
        entry: entry.to_owned(),
        line: None,
        dropped,
        problem,
    }
}

fn parse_session(
    path: &Path,
    group: &[&str],
    bytes: &[u8],
    local_user: &str,
) -> Result<(ConfigHost, Option<Endpoint>, Vec<ImportProblem>), ImportProblem> {
    let name = path
        .file_stem()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| valid_label(name))
        .ok_or(ImportProblem::XshellFile)?;
    let decoded = decode_windows_text(bytes).ok_or(ImportProblem::XshellFile)?;
    let settings = Settings::parse(&decoded)?;
    if !settings.get("protocol").is_some_and(|protocol| {
        protocol.eq_ignore_ascii_case("ssh") || protocol.eq_ignore_ascii_case("sftp")
    }) {
        return Err(if settings.get("protocol").is_some() {
            ImportProblem::XshellUnsupportedSession
        } else {
            ImportProblem::XshellFile
        });
    }

    let host = Endpoint::parse(
        settings.get("host"),
        settings.get("port"),
        settings
            .get("username")
            .or_else(|| settings.get("legacy_username")),
        settings
            .get("user_key")
            .or_else(|| settings.get("legacy_user_key")),
        local_user,
    )?;
    let gateway = settings.gateway(local_user)?;
    let endpoints = || std::iter::once(&host).chain(gateway.iter());
    let mut problems = Vec::new();
    if settings.credentials {
        problems.push(ImportProblem::XshellCredentials);
    }
    if endpoints().any(|endpoint| endpoint.default_user) {
        problems.push(ImportProblem::XshellDefaultUser);
    }
    if endpoints().any(|endpoint| endpoint.unmapped_key) {
        problems.push(ImportProblem::XshellKeyPath);
    }
    if settings.unsupported {
        problems.push(ImportProblem::XshellUnsupportedSettings);
    }
    let group = group.iter().map(|part| part.trim().to_owned()).collect();
    Ok((host.host(name.to_owned(), group), gateway, problems))
}

#[derive(Default)]
struct Settings<'a> {
    fields: BTreeMap<&'static str, &'a str>,
    credentials: bool,
    unsupported: bool,
}

impl<'a> Settings<'a> {
    fn parse(text: &'a str) -> Result<Self, ImportProblem> {
        if text.contains('\0') {
            return Err(ImportProblem::XshellFile);
        }
        let mut settings = Self::default();
        let mut section = String::new();
        for line in text.lines().map(str::trim) {
            if line.is_empty() || line.starts_with(['#', ';']) {
                continue;
            }
            if let Some(header) = line.strip_prefix('[') {
                section = header
                    .strip_suffix(']')
                    .ok_or(ImportProblem::XshellFile)?
                    .trim()
                    .to_ascii_lowercase();
                continue;
            }
            let (key, value) = line.split_once('=').ok_or(ImportProblem::XshellFile)?;
            let key = key.trim().to_ascii_lowercase();
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            if credential_field(&section, &key) {
                settings.credentials = true;
                continue;
            }
            let field = match (section.as_str(), key.as_str()) {
                ("connection", "protocol") => "protocol",
                ("connection", "host") => "host",
                ("connection", "port") => "port",
                ("connection", "username") => "legacy_username",
                ("connection", "userkey" | "userkeyname") => "legacy_user_key",
                ("connection:authentication", "username") => "username",
                ("connection:authentication", "userkey" | "userkeyname") => "user_key",
                ("connection" | "connection:proxy", "proxy") => "proxy",
                ("connection:proxy", "type") => "proxy_type",
                ("connection:proxy", "host") => "jump_host",
                ("connection:proxy", "port") => "jump_port",
                ("connection:proxy", "username") => "jump_user",
                ("connection:proxy", "userkey" | "userkeyname") => "jump_key",
                ("connection:proxy", "sessionfile" | "nextproxy") if configured(value) => {
                    "external_route"
                }
                ("connection:proxy", "sessionfile" | "nextproxy") => continue,
                ("sessioninfo", "version" | "description") => continue,
                ("connection:proxy", "startup") if value == "0" => continue,
                ("connection" | "connection:authentication", "method") if basic_auth(value) => {
                    continue
                }
                _ => {
                    settings.unsupported = true;
                    continue;
                }
            };
            settings.fields.insert(field, value);
        }
        Ok(settings)
    }

    fn get(&self, field: &'static str) -> Option<&'a str> {
        self.fields.get(field).copied()
    }

    fn gateway(&self, local_user: &str) -> Result<Option<Endpoint>, ImportProblem> {
        // Xshell usually names an external proxy profile here. A name alone
        // supplies neither its type nor the SSH endpoint. Import a route only
        // when the file supplies an explicitly typed Jump host and its details.
        let kind = self.get("proxy_type").filter(|value| configured(value));
        if kind.is_some_and(|kind| kind.eq_ignore_ascii_case("jumphost")) {
            if self.get("external_route").is_some() {
                return Err(ImportProblem::XshellUnsupportedProxy);
            }
            return Endpoint::parse(
                self.get("jump_host"),
                self.get("jump_port"),
                self.get("jump_user"),
                self.get("jump_key"),
                local_user,
            )
            .map(Some)
            .map_err(|_| ImportProblem::XshellInvalidJumpHost);
        }
        if kind.is_some()
            || [
                "proxy",
                "jump_host",
                "jump_port",
                "jump_user",
                "jump_key",
                "external_route",
            ]
            .iter()
            .any(|field| self.get(field).is_some_and(configured))
        {
            return Err(ImportProblem::XshellUnsupportedProxy);
        }
        Ok(None)
    }
}

fn credential_field(section: &str, key: &str) -> bool {
    section.ends_with(":password")
        || key.contains("password")
        || key.contains("passphrase")
        || matches!(key, "passwd" | "credential" | "secret" | "token" | "pin")
}

fn configured(value: &str) -> bool {
    !["0", "none", "<none>", "(none)"]
        .iter()
        .any(|placeholder| value.eq_ignore_ascii_case(placeholder))
}

fn basic_auth(value: &str) -> bool {
    value.split(',').all(|method| {
        ["0", "1", "password", "public key", "keyboard interactive"]
            .iter()
            .any(|basic| method.trim().eq_ignore_ascii_case(basic))
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
    fn parse(
        address: Option<&str>,
        port: Option<&str>,
        user: Option<&str>,
        key: Option<&str>,
        local_user: &str,
    ) -> Result<Self, ImportProblem> {
        let address = address
            .and_then(ssh_address)
            .ok_or(ImportProblem::XshellFile)?;
        let port = port.map_or(Ok(22), |port| {
            port.parse::<u16>()
                .ok()
                .filter(|&port| port != 0)
                .ok_or(ImportProblem::XshellInvalidPort)
        })?;
        let username = user.unwrap_or(local_user);
        if !valid_label(username) || username.contains([':', '/']) {
            return Err(ImportProblem::XshellFile);
        }
        let key = key.filter(|key| configured(key));
        let identity_file = key.and_then(key_path);
        Ok(Self {
            address: address.to_owned(),
            port,
            user: username.to_owned(),
            default_user: user.is_none(),
            unmapped_key: key.is_some() && identity_file.is_none(),
            identity_file,
        })
    }

    fn host(self, name: String, group_path: Vec<String>) -> ConfigHost {
        ConfigHost {
            name,
            address: self.address,
            port: self.port,
            user: self.user,
            identity_file: self.identity_file,
            identities_only: false,
            forward_agent: false,
            keepalive_seconds: None,
            jump_host: None,
            proxy_command: None,
            forwards: Vec::new(),
            group_path,
        }
    }
}

fn key_path(value: &str) -> Option<PathBuf> {
    let value = value
        .strip_prefix('"')
        .and_then(|path| path.strip_suffix('"'))
        .unwrap_or(value);
    let windows_absolute =
        matches!(value.as_bytes(), [drive, b':', b'\\' | b'/', ..] if drive.is_ascii_alphabetic());
    if !valid_label(value) || value.contains("://") {
        return None;
    }
    // Xshell's managed user key name alone is not a portable filesystem path.
    (Path::new(value).is_absolute()
        || windows_absolute
        || value.starts_with("~/")
        || value.starts_with("\\\\"))
    .then(|| PathBuf::from(value))
}
