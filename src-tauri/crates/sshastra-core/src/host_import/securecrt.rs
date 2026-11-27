use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::{
    decode_windows_text, portable_key_path, relative_session_path, ssh_address, valid_label,
    ConfigHost, ImportIssue, ImportProblem, ParsedConfig,
};

/// Built-in template and folder metadata filenames in a SecureCRT Sessions folder.
pub const SECURECRT_NON_SESSION_FILES: [&str; 2] = ["Default.ini", "__FolderData__.ini"];

/// Parses saved SecureCRT SSH2 sessions from (relative path, contents) pairs.
/// The selected folder itself contributes no Group. Identity and dependency
/// references are interpreted using only the supplied data.
pub fn parse_securecrt<'a>(
    files: impl IntoIterator<Item = (&'a Path, &'a [u8])>,
    local_user: &str,
) -> ParsedConfig {
    let mut parsed = ParsedConfig::default();
    let mut sessions = Vec::new();
    for (path, bytes) in files {
        let Some(parts) = relative_session_path(path, "ini") else {
            parsed
                .issues
                .push(issue("", true, ImportProblem::SecurecrtFile));
            continue;
        };
        let (file, groups) = parts.split_last().expect("a session path has a filename");
        if SECURECRT_NON_SESSION_FILES
            .iter()
            .any(|name| name.eq_ignore_ascii_case(file))
        {
            continue;
        }
        let entry = parts.join("/");
        let name = file[..file.len() - ".ini".len()].trim();
        match parse_session(&entry, name, groups, bytes, local_user) {
            Ok(session) => sessions.push(session),
            Err(problem) => parsed.issues.push(issue(&entry, true, problem)),
        }
    }

    resolve_routes(sessions, &mut parsed);
    parsed
}

struct Session {
    entry: String,
    host: ConfigHost,
    jump_path: Option<String>,
    problems: Vec<ImportProblem>,
}

/// Follow references in the source by session path. HostStore can only bind a
/// Jump host by name, so a duplicate name is an ambiguous target.
fn resolve_routes(sessions: Vec<Session>, parsed: &mut ParsedConfig) {
    let mut paths = HashMap::new();
    let mut name_counts = HashMap::new();
    for (index, session) in sessions.iter().enumerate() {
        let path = session.entry[..session.entry.len() - ".ini".len()].to_ascii_lowercase();
        paths
            .entry(path)
            .and_modify(|target| *target = None)
            .or_insert(Some(index));
        *name_counts.entry(session.host.name.as_str()).or_insert(0) += 1;
    }

    let mut ready = Vec::new();
    let mut dependents = vec![Vec::new(); sessions.len()];
    let mut routes = vec![None; sessions.len()];
    for (index, session) in sessions.iter().enumerate() {
        let Some(path) = &session.jump_path else {
            ready.push(index);
            continue;
        };
        if let Some(&Some(target)) = paths.get(path) {
            let gateway = &sessions[target].host.name;
            if name_counts[gateway.as_str()] == 1 {
                dependents[target].push(index);
                routes[index] = Some(gateway.clone());
            }
        }
    }

    // Walk outwards from direct sessions. Cycles and routes that depend on
    // missing or unimportable sessions cannot reach a direct session.
    let mut reachable = vec![false; sessions.len()];
    while let Some(index) = ready.pop() {
        reachable[index] = true;
        ready.extend(dependents[index].iter().copied());
    }

    for (index, mut session) in sessions.into_iter().enumerate() {
        if reachable[index] {
            session.host.jump_host = routes[index].take();
            parsed.hosts.push(session.host);
            parsed.issues.extend(
                session
                    .problems
                    .into_iter()
                    .map(|problem| issue(&session.entry, false, problem)),
            );
        } else {
            parsed.issues.push(issue(
                &session.entry,
                true,
                ImportProblem::SecurecrtJumpHostUnavailable,
            ));
        }
    }
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
    entry: &str,
    name: &str,
    groups: &[&str],
    bytes: &[u8],
    local_user: &str,
) -> Result<Session, ImportProblem> {
    if !valid_label(name) {
        return Err(ImportProblem::SecurecrtFile);
    }
    let decoded = decode_windows_text(bytes).ok_or(ImportProblem::SecurecrtFile)?;
    let settings = Settings::parse(&decoded)?;
    if !settings
        .protocol
        .ok_or(ImportProblem::SecurecrtFile)?
        .eq_ignore_ascii_case("SSH2")
    {
        return Err(ImportProblem::SecurecrtUnsupportedSession);
    }
    let address = settings
        .hostname
        .and_then(ssh_address)
        .ok_or(ImportProblem::SecurecrtFile)?;
    let port = match settings.port {
        Some(value) => hexadecimal(value)
            .and_then(|port| u16::try_from(port).ok())
            .filter(|&port| port != 0)
            .ok_or(ImportProblem::SecurecrtInvalidPort)?,
        None => 22,
    };
    let username = settings.username.filter(|user| !user.is_empty());
    let user = username.unwrap_or(local_user);
    if !valid_label(user) || user.contains([':', '/']) {
        return Err(ImportProblem::SecurecrtFile);
    }
    let mut problems = Vec::new();
    let identity_file = settings.identity_file(&mut problems);
    let jump_path = match settings.firewall {
        None | Some("") => None,
        Some(value) if value.eq_ignore_ascii_case("None") => None,
        Some(value) => {
            let (_, path) = value
                .split_once(':')
                .filter(|(kind, _)| kind.eq_ignore_ascii_case("Session"))
                .ok_or(ImportProblem::SecurecrtUnsupportedFirewall)?;
            Some(path.replace('\\', "/").to_ascii_lowercase())
        }
    };
    if username.is_none() {
        problems.push(ImportProblem::SecurecrtDefaultUser);
    }
    if settings.credentials {
        problems.push(ImportProblem::SecurecrtCredentials);
    }
    if settings.unsupported {
        problems.push(ImportProblem::SecurecrtUnsupportedSettings);
    }
    Ok(Session {
        entry: entry.to_owned(),
        host: ConfigHost {
            name: name.to_owned(),
            address: address.to_owned(),
            port,
            user: user.to_owned(),
            identity_file,
            identities_only: false,
            forward_agent: false,
            keepalive_seconds: None,
            jump_host: None,
            proxy_command: None,
            forwards: Vec::new(),
            group_path: groups.iter().map(|group| group.trim().to_owned()).collect(),
        },
        jump_path,
        problems,
    })
}

#[derive(Default)]
struct Settings<'a> {
    protocol: Option<&'a str>,
    hostname: Option<&'a str>,
    port: Option<&'a str>,
    username: Option<&'a str>,
    identity: Option<&'a str>,
    legacy_identity: Option<&'a str>,
    global_identity: Option<&'a str>,
    firewall: Option<&'a str>,
    credentials: bool,
    unsupported: bool,
}

impl<'a> Settings<'a> {
    fn parse(text: &'a str) -> Result<Self, ImportProblem> {
        if text.contains('\0') {
            return Err(ImportProblem::SecurecrtFile);
        }
        let mut settings = Self::default();
        let mut lines = text.lines().map(str::trim);
        while let Some(line) = lines.next() {
            if line.is_empty() || line.starts_with(['#', ';']) {
                continue;
            }
            let (kind, field) = line.split_once(':').ok_or(ImportProblem::SecurecrtFile)?;
            let (name, value) = field
                .strip_prefix('"')
                .and_then(|field| field.split_once("\"="))
                .ok_or(ImportProblem::SecurecrtFile)?;
            let name = name.to_ascii_lowercase();
            let value = value.trim();
            let configured = match kind {
                "S" => !value.is_empty(),
                "D" => hexadecimal(value) != Some(0),
                "B" | "Z" => {
                    // A B record counts hexadecimal bytes. A Z record counts
                    // strings, each on its own line. Neither body is settings.
                    let mut count = hexadecimal(value).ok_or(ImportProblem::SecurecrtFile)?;
                    let configured = count != 0;
                    while count != 0 {
                        let line = lines.next().ok_or(ImportProblem::SecurecrtFile)?;
                        let items = if kind == "Z" {
                            1
                        } else {
                            hex_bytes(line).ok_or(ImportProblem::SecurecrtFile)?
                        };
                        count = count
                            .checked_sub(items)
                            .ok_or(ImportProblem::SecurecrtFile)?;
                    }
                    configured
                }
                _ => return Err(ImportProblem::SecurecrtFile),
            };
            if credential_field(&name) {
                settings.credentials |= configured;
                continue;
            }
            match (kind, name.as_str()) {
                ("S", "protocol name") => settings.protocol = Some(value),
                ("S", "hostname") => settings.hostname = Some(value),
                ("D", "[ssh2] port") => settings.port = Some(value),
                ("S", "username") => settings.username = Some(value),
                ("S", "identity filename v2") => settings.identity = Some(value),
                ("S", "identity filename") => settings.legacy_identity = Some(value),
                ("D", "use global public key") => settings.global_identity = Some(value),
                ("S", "firewall name") => settings.firewall = Some(value),
                ("D", "is session" | "ssh2 common config version") => {}
                (_, "[ssh2] port") => return Err(ImportProblem::SecurecrtInvalidPort),
                (_, "firewall name") => return Err(ImportProblem::SecurecrtUnsupportedFirewall),
                (
                    _,
                    "protocol name"
                    | "hostname"
                    | "username"
                    | "use global public key"
                    | "identity filename"
                    | "identity filename v2",
                ) => {
                    return Err(ImportProblem::SecurecrtFile);
                }
                _ => settings.unsupported |= configured,
            }
        }
        Ok(settings)
    }

    fn identity_file(&self, problems: &mut Vec<ImportProblem>) -> Option<PathBuf> {
        if self
            .global_identity
            .is_some_and(|value| hexadecimal(value) != Some(0))
        {
            problems.push(ImportProblem::SecurecrtKeyPath);
            return None;
        }
        let saved = self
            .identity
            .or(self.legacy_identity)
            .filter(|path| !path.is_empty());
        let key = saved
            .filter(|path| !path.contains("${"))
            .and_then(portable_key_path);
        if key.is_none() && (saved.is_some() || self.global_identity.is_some()) {
            problems.push(ImportProblem::SecurecrtKeyPath);
        }
        key
    }
}

fn credential_field(name: &str) -> bool {
    name.contains("password")
        || name.contains("passphrase")
        || name.starts_with("credential")
        || matches!(name, "passwd" | "secret" | "token" | "pin")
}

fn hexadecimal(value: &str) -> Option<u32> {
    if !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(value, 16).ok()
}

fn hex_bytes(line: &str) -> Option<u32> {
    let mut count = 0;
    for byte in line.split_ascii_whitespace() {
        if byte.len() != 2 || !byte.bytes().all(|digit| digit.is_ascii_hexdigit()) {
            return None;
        }
        count += 1;
    }
    (count != 0).then_some(count)
}
