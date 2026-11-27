use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::PathBuf;

use encoding_rs::{Encoding, WINDOWS_1252};

use super::{ConfigHost, ImportIssue, ImportProblem, ParsedConfig};

const SESSIONS_KEY: &str = r"HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions";
const DEFAULT_SETTINGS: &str = "Default Settings";
const SSH_PORT: u16 = 22;
// ProxyMethod values and defaults on disk, per PuTTY's conf-enums.h and conf.h.
const SSH_PORT_FORWARDING_PROXY: u32 = 6;
const DEFAULT_PROXY_PORT: u16 = 80;
const HOST_NAME: &str = "HostName";
const USER_NAME: &str = "UserName";
const KEY_FILE: &str = "PublicKeyFile";

/// Reads PuTTY's Windows registry export without accessing the registry or
/// key files. Named sessions store their own settings. Registry subkeys can
/// describe Groups, while an escaped backslash is part of a session name.
pub fn parse_putty(bytes: &[u8], local_user: &str) -> ParsedConfig {
    let mut parsed = ParsedConfig::default();
    let Some(text) = registry_text(bytes) else {
        parsed.issues.push(file_issue(1, ImportProblem::PuttyFile));
        return parsed;
    };
    let Some(sessions) = read_sessions(&text, &mut parsed.issues) else {
        return parsed;
    };
    let defaults = sessions.iter().find(|session| session.is_template());
    let mut aliases = HashMap::new();
    let mut host_names = HashSet::new();
    let mut pending = Vec::new();
    for session in sessions.iter().filter(|session| !session.is_template()) {
        let name = session.name();
        let alias = session
            .path
            .iter()
            .map(|part| part.to_ascii_lowercase())
            .collect();
        let index = match session.host(local_user, &mut parsed.issues) {
            Ok(host) => {
                let index = pending.len();
                pending.push((host, session));
                // Grouped sessions can share a name. The shared import keeps
                // the first one, so only that entry is a usable Jump host.
                host_names.insert(name.to_owned()).then_some(index)
            }
            Err(problem) => {
                parsed.issues.push(session_issue(name, true, problem));
                None
            }
        };
        aliases.entry(alias).or_insert((name, index));
    }

    let mut links = Vec::new();
    let mut generated = HashMap::new();
    let mut i = 0;
    while i < pending.len() {
        let session = pending[i].1;
        let route = match session.proxy_method() {
            Ok(SSH_PORT_FORWARDING_PROXY) => {
                session.jump(local_user, defaults, &aliases).map(|jump| {
                    let (source, mut hop, settings) = match jump {
                        Jump::Saved(index, user) => {
                            let (hop, settings) = &pending[index];
                            let Some(user) = user
                                .filter(|user| user != &hop.user && !settings.has_inline_user())
                            else {
                                return Some(index);
                            };
                            let mut hop = hop.clone();
                            hop.user = user;
                            (Some(index), hop, *settings)
                        }
                        Jump::Direct(hop, settings) => (None, hop, settings),
                    };
                    let key = (source, hop.address.clone(), hop.port, hop.user.clone());
                    let next = *generated.entry(key).or_insert_with(|| {
                        let address = if hop.address.contains(':') {
                            format!("[{}]", hop.address)
                        } else {
                            hop.address.clone()
                        };
                        let base = format!("{}@{}:{}", hop.user, address, hop.port);
                        hop.name = unique_name(base, &mut host_names);
                        hop.forward_agent = false;
                        let index = pending.len();
                        pending.push((hop, settings));
                        index
                    });
                    Some(next)
                })
            }
            // Invalid and unsupported proxy methods are already reported as
            // omitted settings. Only the wire-level SSH forwarding is linked.
            _ => Ok(None),
        };
        links.push(route);
        i += 1;
    }

    for (index, (mut host, _)) in pending.iter().cloned().enumerate() {
        match reachable(index, &links, &pending) {
            Ok(hop) => {
                host.jump_host = hop.map(|hop| pending[hop].0.name.clone());
                parsed.hosts.push(host);
            }
            Err(problem) => parsed.issues.push(session_issue(&host.name, true, problem)),
        }
    }
    parsed
}

fn registry_text(bytes: &[u8]) -> Option<Cow<'_, str>> {
    if let Some((encoding, bom)) = Encoding::for_bom(bytes) {
        return encoding.decode_without_bom_handling_and_without_replacement(&bytes[bom..]);
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => Some(Cow::Borrowed(text)),
        Err(_) if bytes.starts_with(b"REGEDIT4") => {
            Some(WINDOWS_1252.decode_without_bom_handling(bytes).0)
        }
        Err(_) => None,
    }
}

fn read_sessions<'a>(text: &'a str, issues: &mut Vec<ImportIssue>) -> Option<Vec<Session<'a>>> {
    let mut lines = text
        .lines()
        .enumerate()
        .map(|(i, line)| (i + 1, line.trim()));
    let header = lines.find(|(_, line)| !line.is_empty());
    if !matches!(
        header,
        Some((_, "Windows Registry Editor Version 5.00" | "REGEDIT4"))
    ) {
        issues.push(file_issue(
            header.map_or(1, |(line, _)| line),
            ImportProblem::PuttyFile,
        ));
        return None;
    }

    let mut sessions: Vec<Session<'a>> = Vec::new();
    let mut active = false;
    let mut continuation = false;
    for (number, line) in lines {
        if let Some(key) = line.strip_prefix('[') {
            active = false;
            continuation = false;
            let Some(prefix) = key.get(..SESSIONS_KEY.len()) else {
                continue;
            };
            if !prefix.eq_ignore_ascii_case(SESSIONS_KEY) {
                continue;
            }
            let Some(path) = key[SESSIONS_KEY.len()..].strip_prefix('\\') else {
                continue;
            };
            match path
                .strip_suffix(']')
                .and_then(|path| path.split('\\').map(decode_name).collect())
            {
                Some(path) => {
                    sessions.push(Session {
                        path,
                        options: BTreeMap::new(),
                    });
                    active = true;
                }
                None => issues.push(file_issue(number, ImportProblem::PuttySessionName)),
            }
        } else if active {
            if continuation {
                continuation = line.ends_with('\\');
                continue;
            }
            if let Some((name, value)) = line
                .strip_prefix('"')
                .and_then(|line| line.split_once('"'))
                .and_then(|(name, rest)| {
                    rest.trim_start()
                        .strip_prefix('=')
                        .map(|value| (name, value.trim()))
                })
            {
                continuation = value.starts_with("hex") && value.ends_with('\\');
                sessions
                    .last_mut()
                    .unwrap()
                    .options
                    .insert(name.to_ascii_lowercase(), (name, value));
            }
        }
    }
    // Container keys are present in exports even when they have no values.
    sessions.retain(|session| !session.options.is_empty());
    Some(sessions)
}

fn decode_name(entry: &str) -> Option<String> {
    let mut input = entry.as_bytes().iter().copied();
    let mut bytes = Vec::with_capacity(entry.len());
    while let Some(next) = input.next() {
        let byte = if next == b'%' {
            let high = char::from(input.next()?).to_digit(16)? as u8;
            let low = char::from(input.next()?).to_digit(16)? as u8;
            high * 16 + low
        } else {
            next
        };
        bytes.push(byte);
    }
    // PuTTY escapes the bytes of each name in the original Windows ANSI
    // code page. An export carries no code page for those bytes, so read
    // valid UTF-8 first and fall back to Windows-1252 for Western names.
    let name = String::from_utf8(bytes).unwrap_or_else(|error| {
        WINDOWS_1252
            .decode_without_bom_handling(error.as_bytes())
            .0
            .into_owned()
    });
    let name = name.trim();
    (!name.is_empty() && !name.chars().any(char::is_control)).then(|| name.to_owned())
}

fn quoted(value: &str) -> Option<String> {
    let mut chars = value.strip_prefix('"')?.strip_suffix('"')?.chars();
    let mut decoded = String::new();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => decoded.push(match chars.next()? {
                escaped @ ('\\' | '"') => escaped,
                _ => return None,
            }),
            '"' => return None,
            ch if ch.is_control() => return None,
            ch => decoded.push(ch),
        }
    }
    Some(decoded.trim().to_owned())
}

fn file_issue(line: usize, problem: ImportProblem) -> ImportIssue {
    ImportIssue {
        entry: String::new(),
        line: Some(line),
        dropped: true,
        problem,
    }
}

fn session_issue(name: &str, dropped: bool, problem: ImportProblem) -> ImportIssue {
    ImportIssue {
        entry: name.to_owned(),
        line: None,
        dropped,
        problem,
    }
}

fn invalid(option: &'static str) -> ImportProblem {
    ImportProblem::PuttyInvalidOption { option }
}

fn credential_field(name: &str) -> bool {
    name.contains("password")
        || name.contains("passphrase")
        || matches!(name, "passwd" | "proxypass")
}

struct Session<'a> {
    path: Vec<String>,
    options: BTreeMap<String, (&'a str, &'a str)>,
}

type Aliases<'a> = HashMap<Vec<String>, (&'a str, Option<usize>)>;

enum Jump<'a> {
    Saved(usize, Option<String>),
    Direct(ConfigHost, &'a Session<'a>),
}

impl Session<'_> {
    fn name(&self) -> &str {
        self.path.last().unwrap()
    }

    fn is_template(&self) -> bool {
        self.path.len() == 1 && self.name().eq_ignore_ascii_case(DEFAULT_SETTINGS)
    }

    fn raw(&self, option: &str) -> Option<&str> {
        self.options
            .get(&option.to_ascii_lowercase())
            .map(|(_, value)| *value)
    }

    fn string(&self, option: &'static str) -> Result<Option<String>, ImportProblem> {
        self.raw(option)
            .map(|value| quoted(value).ok_or_else(|| invalid(option)))
            .transpose()
            .map(|value| value.filter(|value| !value.is_empty()))
    }

    fn number(&self, option: &'static str) -> Result<Option<u32>, ImportProblem> {
        self.raw(option)
            .map(|value| {
                let digits = value
                    .get(..6)
                    .filter(|part| part.eq_ignore_ascii_case("dword:"))
                    .map(|_| &value[6..])
                    .filter(|part| {
                        part.len() == 8 && part.bytes().all(|byte| byte.is_ascii_hexdigit())
                    });
                digits
                    .and_then(|digits| u32::from_str_radix(digits, 16).ok())
                    .ok_or_else(|| invalid(option))
            })
            .transpose()
    }

    fn port(&self, option: &'static str, default: u16) -> Result<u16, ImportProblem> {
        self.number(option)?.map_or(Ok(default), |number| {
            u16::try_from(number)
                .ok()
                .filter(|&port| port > 0)
                .ok_or_else(|| invalid(option))
        })
    }

    fn has_inline_user(&self) -> bool {
        self.raw(HOST_NAME)
            .is_some_and(|hostname| hostname.contains('@'))
    }

    fn proxy_method(&self) -> Result<u32, ImportProblem> {
        Ok(self.number("ProxyMethod")?.unwrap_or_default())
    }

    fn host(
        &self,
        local_user: &str,
        issues: &mut Vec<ImportIssue>,
    ) -> Result<ConfigHost, ImportProblem> {
        let name = self.name();
        if self
            .string("Protocol")?
            .is_some_and(|protocol| !protocol.eq_ignore_ascii_case("ssh"))
        {
            return Err(ImportProblem::PuttyUnsupportedProtocol);
        }

        let hostname = self.string(HOST_NAME)?.ok_or_else(|| invalid(HOST_NAME))?;
        let (address, inline_user) = endpoint(&hostname, HOST_NAME)?;
        let port = self.port("PortNumber", SSH_PORT)?;
        let mut report = |problem| issues.push(session_issue(name, false, problem));
        if self
            .options
            .iter()
            .any(|(key, (_, value))| credential_field(key) && *value != "\"\"" && *value != "-")
        {
            report(ImportProblem::PuttyCredentials);
        }
        let mut unsupported = BTreeSet::new();
        self.unsupported_options(&mut unsupported);
        if !unsupported.is_empty() {
            report(ImportProblem::PuttyUnsupportedOptions {
                options: unsupported.into_iter().collect::<Vec<_>>().join(", "),
            });
        }
        let mut optional = |value: Result<Option<String>, ImportProblem>| match value {
            Ok(value) => value,
            Err(problem) => {
                report(problem);
                None
            }
        };
        let user = inline_user.or_else(|| {
            optional(
                self.string(USER_NAME)
                    .and_then(|user| valid_user(user, USER_NAME)),
            )
        });
        let identity_file = optional(self.string(KEY_FILE)).map(PathBuf::from);
        if user.is_none() {
            report(ImportProblem::PuttyDefaultUser);
        }
        let forward_agent = match self.number("AgentFwd") {
            Ok(None | Some(0)) => false,
            Ok(Some(1)) => true,
            _ => {
                report(invalid("AgentFwd"));
                false
            }
        };
        let keepalive_seconds = match self.keepalive() {
            Ok(interval) => interval,
            Err(problem) => {
                report(problem);
                None
            }
        };
        if let Err(problem) = self.proxy_method() {
            report(problem);
        }
        Ok(ConfigHost {
            name: name.to_owned(),
            address,
            port,
            user: user.unwrap_or_else(|| local_user.to_owned()),
            identity_file,
            identities_only: false,
            forward_agent,
            keepalive_seconds,
            jump_host: None,
            proxy_command: None,
            forwards: Vec::new(),
            group_path: self.path[..self.path.len() - 1].to_vec(),
        })
    }

    fn keepalive(&self) -> Result<Option<u32>, ImportProblem> {
        let minutes = self.number("PingInterval")?;
        let seconds = self.number("PingIntervalSecs")?;
        if minutes.is_none() && seconds.is_none() {
            return Ok(None);
        }
        let interval = minutes
            .unwrap_or_default()
            .checked_mul(60)
            .and_then(|min| min.checked_add(seconds.unwrap_or_default()))
            .ok_or_else(|| invalid("PingInterval"))?;
        Ok(Some(interval))
    }

    fn unsupported_options<'a>(&'a self, unsupported: &mut BTreeSet<&'a str>) {
        let method = self.proxy_method().ok();
        for (key, (name, value)) in &self.options {
            let omit =
                match key.as_str() {
                    "present" | "protocol" | "hostname" | "portnumber" | "username"
                    | "publickeyfile" | "agentfwd" | "pinginterval" | "pingintervalsecs" => false,
                    "proxymethod" => method
                        .is_some_and(|method| !matches!(method, 0 | SSH_PORT_FORWARDING_PROXY)),
                    "proxyhost" | "proxyport" | "proxyusername" => method
                        .is_some_and(|method| !matches!(method, 0 | SSH_PORT_FORWARDING_PROXY)),
                    "proxytelnetcommand" => matches!(method, Some(4 | 5 | 7 | 8)),
                    "proxyexcludelist" | "remotecommand" | "portforwardings" => *value != "\"\"",
                    "proxylocalhost" | "usernamefromenvironment" => *value != "dword:00000000",
                    "tryagent" => *value != "dword:00000001",
                    _ => !credential_field(key),
                };
            if omit && name.chars().all(|ch| ch.is_ascii_alphanumeric()) {
                unsupported.insert(name);
            }
        }
    }

    fn jump<'a>(
        &'a self,
        local_user: &str,
        defaults: Option<&'a Session<'a>>,
        aliases: &Aliases<'_>,
    ) -> Result<Jump<'a>, ImportProblem> {
        let hostname = self
            .string("ProxyHost")?
            .ok_or_else(|| invalid("ProxyHost"))?;
        let user = valid_user(self.string("ProxyUsername")?, "ProxyUsername")?;
        let alias = hostname.to_ascii_lowercase();
        // A real PuTTY session name can contain an escaped backslash. Prefer
        // that saved session before considering an explicit nested key.
        let saved = aliases.get(std::slice::from_ref(&alias)).or_else(|| {
            let path: Vec<_> = alias.split('\\').map(str::to_owned).collect();
            aliases.get(&path)
        });
        if let Some(&(name, index)) = saved {
            return index.map(|index| Jump::Saved(index, user)).ok_or_else(|| {
                ImportProblem::JumpHostUnavailable {
                    hop: name.to_owned(),
                }
            });
        }
        let (address, inline_user) = endpoint(&hostname, "ProxyHost")?;
        let settings = defaults.unwrap_or(&EMPTY_SETTINGS);
        let default_user = valid_user(settings.string(USER_NAME)?, USER_NAME)?;
        let identity_file = settings.string(KEY_FILE)?.map(PathBuf::from);
        if !matches!(settings.proxy_method()?, 0 | SSH_PORT_FORWARDING_PROXY) {
            return Err(ImportProblem::PuttyUnsupportedOptions {
                options: "ProxyMethod".into(),
            });
        }
        let port = self.port("ProxyPort", DEFAULT_PROXY_PORT)?;
        Ok(Jump::Direct(
            ConfigHost {
                name: address.clone(),
                address,
                port,
                user: inline_user
                    .or(user)
                    .or(default_user)
                    .unwrap_or_else(|| local_user.to_owned()),
                identity_file,
                identities_only: false,
                forward_agent: false,
                keepalive_seconds: None,
                jump_host: None,
                proxy_command: None,
                forwards: Vec::new(),
                group_path: Vec::new(),
            },
            settings,
        ))
    }
}

static EMPTY_SETTINGS: Session<'static> = Session {
    path: Vec::new(),
    options: BTreeMap::new(),
};

fn valid_user(user: Option<String>, option: &'static str) -> Result<Option<String>, ImportProblem> {
    if user.as_ref().is_some_and(|user| user.contains([':', '/'])) {
        return Err(invalid(option));
    }
    Ok(user)
}

/// PuTTY uses PortNumber independently of a colon suffix in HostName, and
/// lets an inline user override the separately saved username.
fn endpoint(value: &str, option: &'static str) -> Result<(String, Option<String>), ImportProblem> {
    let (user, host) = match value.rsplit_once('@') {
        Some((user, host)) if !user.trim().is_empty() => (Some(user.trim().to_owned()), host),
        Some(_) => return Err(invalid(option)),
        None => (None, value),
    };
    let user = valid_user(user, option)?;
    let host = if let Some(bracketed) = host.strip_prefix('[') {
        let (host, suffix) = bracketed.split_once(']').ok_or_else(|| invalid(option))?;
        if !suffix.is_empty() && !suffix.starts_with(':') {
            return Err(invalid(option));
        }
        host
    } else if host.bytes().filter(|byte| *byte == b':').count() == 1 {
        host.split_once(':').unwrap().0
    } else {
        host
    };
    if host.is_empty()
        || host.contains(['/', '\\', '@', '[', ']'])
        || host.chars().any(char::is_whitespace)
        || value.contains("://")
    {
        return Err(invalid(option));
    }
    Ok((host.to_owned(), user))
}

fn unique_name(base: String, used: &mut HashSet<String>) -> String {
    if used.insert(base.clone()) {
        return base;
    }
    (2..)
        .map(|number| format!("{base} ({number})"))
        .find(|name| used.insert(name.clone()))
        .unwrap()
}

fn reachable(
    start: usize,
    links: &[Result<Option<usize>, ImportProblem>],
    pending: &[(ConfigHost, &Session<'_>)],
) -> Result<Option<usize>, ImportProblem> {
    let Some(first) = links[start].clone()? else {
        return Ok(None);
    };
    let mut seen = HashSet::from([start]);
    let mut current = first;
    loop {
        if !seen.insert(current) {
            return Err(if current == start {
                ImportProblem::JumpHostLoop
            } else {
                ImportProblem::JumpHostUnavailable {
                    hop: pending[first].0.name.clone(),
                }
            });
        }
        match links[current] {
            Ok(Some(next)) => current = next,
            Ok(None) => return Ok(Some(first)),
            Err(_) => {
                return Err(ImportProblem::JumpHostUnavailable {
                    hop: pending[first].0.name.clone(),
                })
            }
        }
    }
}
