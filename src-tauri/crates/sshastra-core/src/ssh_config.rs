//! SshConfigImporter: reads OpenSSH's `~/.ssh/config` into Hosts.
//!
//! [`parse`] is a pure function: config text in, the Hosts it describes plus
//! what could not be understood out. Reading `Include`d files is left to the
//! caller's resolver ([`FsIncludes`] for the real file system), so tests feed
//! it from memory. [`crate::hosts::HostStore::import_ssh_config`] then saves
//! the result, skipping Hosts whose name is already taken.
//!
//! Understood: `Host` blocks with patterns (`*`, `?`, `!`), settings before
//! the first `Host`, OpenSSH's "first value obtained wins" across every
//! matching block (so a trailing `Host *` supplies defaults), `HostName`,
//! `Port`, `User`, `IdentityFile` (the first one), `ProxyJump` (as Jump
//! hosts), `Include`, `LocalForward`, `RemoteForward` and `DynamicForward` (as
//! auto-start Port forward rules, since `ssh` sets them up on every connect). `ProxyCommand` Hosts are reported and
//! skipped; `Match` blocks are reported and ignored; other directives are
//! ignored.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::forward::{ForwardDraft, ForwardKind, LOOPBACK, REMOTE_LOOPBACK};

/// What the parse needs to know about the machine it runs on.
#[derive(Debug, Clone)]
pub struct ParseContext {
    /// The user to log in as when the config names none (as `ssh` does).
    pub local_user: String,
}

/// One file an `Include` pattern matched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncludedFile {
    pub name: String,
    pub text: String,
}

/// A Host as the config describes it, ready to save. `jump_host` names
/// another `ConfigHost` (or an already saved Host) by name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigHost {
    pub name: String,
    pub address: String,
    pub port: u16,
    pub user: String,
    /// `~/` is kept as written; `HostAuth::Key` understands it.
    pub identity_file: Option<PathBuf>,
    pub jump_host: Option<String>,
    pub forwards: Vec<ForwardDraft>,
}

/// Something in the config that could not be imported as written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportIssue {
    /// The Host alias, or the `Include` / `Match` line, it concerns.
    pub entry: String,
    /// The Host was not imported at all (otherwise only this part of it).
    pub dropped: bool,
    pub problem: ImportProblem,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ImportProblem {
    /// A directive's value could not be understood.
    InvalidValue { directive: String, value: String },
    /// A directive sshastra cannot do (yet).
    Unsupported { directive: String },
    /// An `Include` could not be read.
    IncludeFailed { reason: String },
    /// A `ProxyJump` chain goes through Host `hop`, which the config itself
    /// reaches another way; a Host has one Jump host chain.
    JumpChainConflict { hop: String },
    /// The Jump hosts lead back to this Host.
    JumpHostLoop,
    /// The Jump host `hop` is not imported, so neither is this Host.
    JumpHostUnavailable { hop: String },
}

/// The outcome of [`parse`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedConfig {
    pub hosts: Vec<ConfigHost>,
    pub issues: Vec<ImportIssue>,
}

/// OpenSSH's limit on nested `Include`s.
const MAX_INCLUDE_DEPTH: usize = 16;

/// Parses config `text`. `includes` resolves one `Include` pattern to the
/// files it matches (none is fine), or says why it cannot.
pub fn parse(
    text: &str,
    ctx: &ParseContext,
    includes: &mut dyn FnMut(&str) -> Result<Vec<IncludedFile>, String>,
) -> ParsedConfig {
    let mut reader = Reader {
        blocks: vec![Block {
            selector: Selector::All,
            directives: Vec::new(),
        }],
        aliases: Vec::new(),
        issues: Vec::new(),
        includes,
    };
    reader.read(text, 0);
    let Reader {
        blocks,
        aliases,
        mut issues,
        ..
    } = reader;
    let config = Config { blocks, ctx };
    let mut hosts = Hosts::default();
    for alias in &aliases {
        match config.alias_host(alias) {
            Ok((host, notes)) => {
                hosts.add(host.host, host.proxy, true);
                issues.extend(notes.into_iter().map(|problem| ImportIssue {
                    entry: alias.clone(),
                    dropped: false,
                    problem,
                }));
            }
            Err(problem) => {
                hosts.dropped.insert(alias.clone());
                issues.push(ImportIssue {
                    entry: alias.clone(),
                    dropped: true,
                    problem,
                });
            }
        }
    }
    issues.extend(hosts.link_jumps(&config));
    ParsedConfig {
        hosts: hosts.list.into_iter().map(|h| h.host).collect(),
        issues,
    }
}

// --- Reading: lines into blocks -------------------------------------------

enum Selector {
    /// Settings before the first `Host` line.
    All,
    Patterns(Vec<String>),
    /// A `Match` block: never applied.
    Never,
}

impl Selector {
    fn matches(&self, alias: &str) -> bool {
        match self {
            Self::All => true,
            Self::Never => false,
            Self::Patterns(patterns) => {
                let alias = alias.to_lowercase();
                let mut any = false;
                for pattern in patterns {
                    let (negated, pattern) = match pattern.strip_prefix('!') {
                        Some(rest) => (true, rest),
                        None => (false, pattern.as_str()),
                    };
                    if glob(&pattern.to_lowercase(), &alias) {
                        if negated {
                            return false;
                        }
                        any = true;
                    }
                }
                any
            }
        }
    }
}

struct Block {
    selector: Selector,
    directives: Vec<Directive>,
}

struct Directive {
    /// Lower-cased.
    keyword: String,
    args: Vec<String>,
}

impl Directive {
    fn value(&self) -> String {
        self.args.join(" ")
    }
}

struct Reader<'a> {
    blocks: Vec<Block>,
    aliases: Vec<String>,
    issues: Vec<ImportIssue>,
    includes: &'a mut dyn FnMut(&str) -> Result<Vec<IncludedFile>, String>,
}

impl Reader<'_> {
    fn read(&mut self, text: &str, depth: usize) {
        for line in text.lines() {
            let Some((keyword, args)) = split_line(line) else {
                continue;
            };
            match keyword.as_str() {
                "host" => {
                    for pattern in &args {
                        let literal = !pattern.starts_with('!') && !pattern.contains(['*', '?']);
                        if literal && !self.aliases.contains(pattern) {
                            self.aliases.push(pattern.clone());
                        }
                    }
                    self.start(Selector::Patterns(args));
                }
                "match" => {
                    self.issues.push(ImportIssue {
                        entry: line.trim().to_owned(),
                        dropped: false,
                        problem: ImportProblem::Unsupported {
                            directive: "Match".into(),
                        },
                    });
                    self.start(Selector::Never);
                }
                "include" => {
                    for pattern in &args {
                        self.include(pattern, depth);
                    }
                }
                _ => self.current().directives.push(Directive { keyword, args }),
            }
        }
    }

    fn start(&mut self, selector: Selector) {
        self.blocks.push(Block {
            selector,
            directives: Vec::new(),
        });
    }

    fn current(&mut self) -> &mut Block {
        self.blocks.last_mut().expect("there is always a block")
    }

    /// Reads the included files in place. Lines after the `Include` still
    /// belong to the block it stands in, even if the files opened new ones.
    fn include(&mut self, pattern: &str, depth: usize) {
        let failed = |reason: String| ImportIssue {
            entry: format!("Include {pattern}"),
            dropped: false,
            problem: ImportProblem::IncludeFailed { reason },
        };
        if depth + 1 >= MAX_INCLUDE_DEPTH {
            self.issues
                .push(failed("includes are nested too deeply".into()));
            return;
        }
        let files = match (self.includes)(pattern) {
            Ok(files) => files,
            Err(reason) => {
                self.issues.push(failed(reason));
                return;
            }
        };
        let blocks_before = self.blocks.len();
        let outer = match &self.current().selector {
            Selector::All => Selector::All,
            Selector::Never => Selector::Never,
            Selector::Patterns(p) => Selector::Patterns(p.clone()),
        };
        for file in files {
            self.read(&file.text, depth + 1);
        }
        if self.blocks.len() != blocks_before {
            self.start(outer);
        }
    }
}

/// A config line as its lower-cased keyword and its arguments; `None` for
/// blank lines and comments.
fn split_line(line: &str) -> Option<(String, Vec<String>)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(line.len());
    let keyword = line[..end].to_lowercase();
    let rest = line[end..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest);
    Some((keyword, split_args(rest)))
}

/// Splits on whitespace; double quotes group (and are removed); a word
/// starting with `#` begins a comment.
fn split_args(text: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut chars = text.chars().peekable();
    loop {
        while chars.next_if(|c| c.is_whitespace()).is_some() {}
        match chars.peek() {
            None | Some('#') => return args,
            _ => {}
        }
        let mut arg = String::new();
        let mut quoted = false;
        while let Some(&c) = chars.peek() {
            if c == '"' {
                quoted = !quoted;
            } else if c.is_whitespace() && !quoted {
                break;
            } else {
                arg.push(c);
            }
            chars.next();
        }
        args.push(arg);
    }
}

/// `*` and `?` glob match.
fn glob(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, ti));
            pi += 1;
        } else if let Some((sp, st)) = star {
            pi = sp + 1;
            ti = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

// --- Resolving: the settings that apply to one alias ----------------------

enum Proxy {
    Jump(String),
    Command,
}

#[derive(Default)]
struct Settings {
    host_name: Option<String>,
    port: Option<String>,
    user: Option<String>,
    identity_file: Option<String>,
    /// `None` inside: `ProxyJump none` / `ProxyCommand none`.
    proxy: Option<Option<Proxy>>,
    /// In order, with their keyword.
    forwards: Vec<(&'static str, String)>,
}

/// A resolved alias, before its Jump hosts are linked.
struct Pending {
    host: ConfigHost,
    /// The raw `ProxyJump` value.
    proxy: Option<String>,
}

struct Config<'a> {
    blocks: Vec<Block>,
    ctx: &'a ParseContext,
}

impl Config<'_> {
    fn settings(&self, alias: &str) -> Settings {
        let mut s = Settings::default();
        let set = |slot: &mut Option<String>, d: &Directive| {
            if slot.is_none() {
                *slot = d.args.first().cloned();
            }
        };
        for block in self.blocks.iter().filter(|b| b.selector.matches(alias)) {
            for d in &block.directives {
                match d.keyword.as_str() {
                    "hostname" => set(&mut s.host_name, d),
                    "port" => set(&mut s.port, d),
                    "user" => set(&mut s.user, d),
                    "identityfile" => set(&mut s.identity_file, d),
                    "proxyjump" | "proxycommand" if s.proxy.is_none() => {
                        let value = d.value();
                        s.proxy = Some(if value.eq_ignore_ascii_case("none") {
                            None
                        } else if d.keyword == "proxyjump" {
                            Some(Proxy::Jump(value))
                        } else {
                            Some(Proxy::Command)
                        });
                    }
                    "localforward" => s.forwards.push(("LocalForward", d.value())),
                    "remoteforward" => s.forwards.push(("RemoteForward", d.value())),
                    "dynamicforward" => s.forwards.push(("DynamicForward", d.value())),
                    _ => {}
                }
            }
        }
        s
    }

    /// The basic connection settings for `alias` (address, port, user, key).
    fn base(&self, alias: &str, s: &Settings) -> Result<ConfigHost, ImportProblem> {
        let address = match &s.host_name {
            Some(name) => expand(name, &[('h', alias)]),
            None => alias.to_owned(),
        };
        let port = match &s.port {
            Some(raw) => parse_port(raw).ok_or_else(|| ImportProblem::InvalidValue {
                directive: "Port".into(),
                value: raw.clone(),
            })?,
            None => 22,
        };
        let user = s
            .user
            .clone()
            .unwrap_or_else(|| self.ctx.local_user.clone());
        let identity_file = s.identity_file.as_ref().map(|raw| {
            let port = port.to_string();
            PathBuf::from(expand(
                raw,
                &[
                    ('d', "~"),
                    ('u', &self.ctx.local_user),
                    ('r', &user),
                    ('h', &address),
                    ('n', alias),
                    ('p', &port),
                ],
            ))
        });
        Ok(ConfigHost {
            name: alias.to_owned(),
            address,
            port,
            user,
            identity_file,
            jump_host: None,
            forwards: Vec::new(),
        })
    }

    /// The Host for a config alias, with notes on what was left out of it,
    /// or why it cannot be imported.
    fn alias_host(&self, alias: &str) -> Result<(Pending, Vec<ImportProblem>), ImportProblem> {
        let s = self.settings(alias);
        let mut host = self.base(alias, &s)?;
        let proxy = match s.proxy {
            Some(Some(Proxy::Command)) => {
                return Err(ImportProblem::Unsupported {
                    directive: "ProxyCommand".into(),
                })
            }
            Some(Some(Proxy::Jump(value))) => Some(value),
            _ => None,
        };
        let mut notes = Vec::new();
        for (directive, value) in s.forwards {
            let kind = match directive {
                "LocalForward" => parse_local_forward(&value),
                "RemoteForward" => parse_remote_forward(&value),
                _ => parse_dynamic_forward(&value),
            };
            match kind {
                // `ssh` sets up a config's forwards on every connect.
                Some(kind) => host.forwards.push(ForwardDraft {
                    label: String::new(),
                    auto_start: true,
                    kind,
                }),
                None => notes.push(ImportProblem::InvalidValue {
                    directive: directive.into(),
                    value,
                }),
            }
        }
        Ok((Pending { host, proxy }, notes))
    }
}

/// Replaces `%x` tokens (and `%%`); unknown tokens are kept as written.
fn expand(text: &str, tokens: &[(char, &str)]) -> String {
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('%') => out.push('%'),
            Some(t) => match tokens.iter().find(|(k, _)| *k == t) {
                Some((_, value)) => out.push_str(value),
                None => {
                    out.push('%');
                    out.push(t);
                }
            },
            None => out.push('%'),
        }
    }
    out
}

fn parse_port(raw: &str) -> Option<u16> {
    raw.parse::<u16>().ok().filter(|&p| p != 0)
}

/// Splits `host:port`, `[v6]:port` or a bare `port` at its last colon.
fn split_host_port(text: &str) -> Option<(Option<String>, u16)> {
    if let Some(rest) = text.strip_prefix('[') {
        let (host, port) = rest.split_once("]:")?;
        return Some((Some(host.to_owned()), parse_port(port)?));
    }
    match text.rsplit_once(':') {
        Some((host, port)) => Some((Some(host.to_owned()), parse_port(port)?)),
        None => Some((None, parse_port(text)?)),
    }
}

/// `[bind_address:]port`, the listening end of a forward: no address is
/// `default`, `*` or an empty one means every interface.
fn parse_listen(text: &str, default: &str) -> Option<(String, u16)> {
    let (bind, port) = split_host_port(text)?;
    let address = match bind.as_deref() {
        None => default.to_owned(),
        Some("" | "*") => "0.0.0.0".to_owned(),
        Some(other) => other.to_owned(),
    };
    Some((address, port))
}

/// `[bind_address:]port host:hostport`: the listening end and the target.
/// Unix sockets are not supported.
fn parse_listen_and_target(value: &str, default: &str) -> Option<((String, u16), (String, u16))> {
    let (listen, target) = value.split_once(' ')?;
    if value.contains('/') {
        return None;
    }
    let listen = parse_listen(listen, default)?;
    let (host, port) = split_host_port(target.trim())?;
    Some((listen, (host.filter(|h| !h.is_empty())?, port)))
}

/// `LocalForward [bind_address:]port host:hostport`.
fn parse_local_forward(value: &str) -> Option<ForwardKind> {
    let ((bind_address, bind_port), (remote_host, remote_port)) =
        parse_listen_and_target(value, LOOPBACK)?;
    Some(ForwardKind::Local {
        bind_address,
        bind_port,
        remote_host,
        remote_port,
    })
}

/// `RemoteForward [bind_address:]port host:hostport`; the server listens on
/// its loopback by default. The SOCKS form (no target) is not supported.
fn parse_remote_forward(value: &str) -> Option<ForwardKind> {
    let ((bind_address, bind_port), (local_host, local_port)) =
        parse_listen_and_target(value, REMOTE_LOOPBACK)?;
    Some(ForwardKind::Remote {
        bind_address,
        bind_port,
        local_host,
        local_port,
    })
}

/// `DynamicForward [bind_address:]port`.
fn parse_dynamic_forward(value: &str) -> Option<ForwardKind> {
    if value.contains('/') || value.contains(' ') {
        return None;
    }
    let (bind_address, bind_port) = parse_listen(value, LOOPBACK)?;
    Some(ForwardKind::Dynamic {
        bind_address,
        bind_port,
    })
}

// --- Linking: ProxyJump into Jump host references --------------------------

/// One `ProxyJump` hop: `[ssh://][user@]host[:port]`.
struct Hop {
    /// The Host name this hop gets: the alias, or the hop as written.
    name: String,
    host: String,
    user: Option<String>,
    port: Option<u16>,
}

fn parse_hop(raw: &str) -> Option<Hop> {
    let text = raw.strip_prefix("ssh://").unwrap_or(raw);
    let (user, rest) = match text.rsplit_once('@') {
        Some((user, rest)) => (Some(user.to_owned()), rest),
        None => (None, text),
    };
    let (host, port) = if rest.starts_with('[') || rest.matches(':').count() == 1 {
        let (host, port) = split_host_port(rest)?;
        (host?, Some(port))
    } else {
        (rest.to_owned(), None)
    };
    if host.is_empty() || user.as_deref() == Some("") {
        return None;
    }
    Some(Hop {
        name: raw.to_owned(),
        host,
        user,
        port,
    })
}

#[derive(Default)]
struct Hosts {
    list: Vec<Pending>,
    /// Aliases not imported.
    dropped: HashSet<String>,
    /// Which entries are config aliases (the rest are ProxyJump hops).
    aliases: HashSet<String>,
}

impl Hosts {
    fn add(&mut self, host: ConfigHost, proxy: Option<String>, alias: bool) {
        if alias {
            self.aliases.insert(host.name.clone());
        }
        self.list.push(Pending { host, proxy });
    }

    fn index(&self, name: &str) -> Option<usize> {
        self.list.iter().position(|p| p.host.name == name)
    }

    /// Turns each alias's `ProxyJump` into `jump_host` names, adding a Host
    /// for every hop that is not an alias, then drops what cannot connect.
    fn link_jumps(&mut self, config: &Config) -> Vec<ImportIssue> {
        let mut issues = Vec::new();
        let mut failed: Vec<(String, ImportProblem)> = Vec::new();
        let mut at = 0;
        while at < self.list.len() {
            let Some(proxy) = self.list[at].proxy.take() else {
                at += 1;
                continue;
            };
            let name = self.list[at].host.name.clone();
            let mut added = Vec::new();
            match self.hops(config, &proxy, &mut added) {
                Ok(jump) => self.list[at].host.jump_host = Some(jump),
                Err(problem) => failed.push((name, problem)),
            }
            // Hop Hosts go right after the first Host that needs them.
            let count = added.len();
            for (offset, hop) in added.into_iter().enumerate() {
                self.list.insert(
                    at + 1 + offset,
                    Pending {
                        host: hop,
                        proxy: None,
                    },
                );
            }
            at += 1 + count;
        }
        for (name, problem) in failed {
            self.drop_host(&name, problem, &mut issues);
        }
        self.drop_loops(&mut issues);
        self.drop_unreachable(&mut issues);
        issues
    }

    /// Resolves a `ProxyJump` value to the name of the last hop, collecting
    /// new hop Hosts into `added`.
    fn hops(
        &self,
        config: &Config,
        proxy: &str,
        added: &mut Vec<ConfigHost>,
    ) -> Result<String, ImportProblem> {
        let mut previous: Option<String> = None;
        for raw in proxy.split(',').map(str::trim) {
            let hop = parse_hop(raw).ok_or_else(|| ImportProblem::InvalidValue {
                directive: "ProxyJump".into(),
                value: proxy.to_owned(),
            })?;
            let is_alias = hop.user.is_none()
                && hop.port.is_none()
                && (self.aliases.contains(&hop.host) || self.dropped.contains(&hop.host));
            if is_alias {
                if self.dropped.contains(&hop.host) {
                    return Err(ImportProblem::JumpHostUnavailable { hop: hop.host });
                }
                // Only the first hop may keep its own Jump hosts.
                if previous.is_some() {
                    let own = self.own_jump(config, &hop.host);
                    if own != previous {
                        return Err(ImportProblem::JumpChainConflict { hop: hop.host });
                    }
                }
                previous = Some(hop.host);
                continue;
            }
            let s = config.settings(&hop.host);
            let mut host = config.base(&hop.host, &s).unwrap_or_else(|_| ConfigHost {
                name: hop.host.clone(),
                address: hop.host.clone(),
                port: 22,
                user: config.ctx.local_user.clone(),
                identity_file: None,
                jump_host: None,
                forwards: Vec::new(),
            });
            host.name = hop.name.clone();
            if let Some(user) = hop.user {
                host.user = user;
            }
            if let Some(port) = hop.port {
                host.port = port;
            }
            host.jump_host = previous.take();
            let existing = self
                .list
                .iter()
                .map(|p| &p.host)
                .chain(added.iter())
                .find(|h| h.name == host.name);
            match existing {
                Some(same) if *same == host => {}
                Some(_) => return Err(ImportProblem::JumpChainConflict { hop: hop.name }),
                None => added.push(host),
            }
            previous = Some(hop.name);
        }
        previous.ok_or_else(|| ImportProblem::InvalidValue {
            directive: "ProxyJump".into(),
            value: proxy.to_owned(),
        })
    }

    /// The direct Jump host alias `name` itself is configured with.
    fn own_jump(&self, config: &Config, name: &str) -> Option<String> {
        if let Some(i) = self.index(name) {
            if let Some(jump) = &self.list[i].host.jump_host {
                return Some(jump.clone());
            }
            if let Some(proxy) = &self.list[i].proxy {
                return proxy.rsplit(',').next().map(|h| h.trim().to_owned());
            }
        }
        match config.settings(name).proxy {
            Some(Some(Proxy::Jump(value))) => value.rsplit(',').next().map(|h| h.trim().to_owned()),
            _ => None,
        }
    }

    fn drop_host(&mut self, name: &str, problem: ImportProblem, issues: &mut Vec<ImportIssue>) {
        if let Some(i) = self.index(name) {
            self.list.remove(i);
            self.dropped.insert(name.to_owned());
            issues.push(ImportIssue {
                entry: name.to_owned(),
                dropped: true,
                problem,
            });
        }
    }

    fn drop_loops(&mut self, issues: &mut Vec<ImportIssue>) {
        let jumps: HashMap<String, String> = self
            .list
            .iter()
            .filter_map(|p| Some((p.host.name.clone(), p.host.jump_host.clone()?)))
            .collect();
        let looping: Vec<String> = self
            .list
            .iter()
            .map(|p| p.host.name.clone())
            .filter(|start| {
                let mut current = start;
                for _ in 0..jumps.len() {
                    match jumps.get(current) {
                        Some(next) if next == start => return true,
                        Some(next) => current = next,
                        None => return false,
                    }
                }
                false
            })
            .collect();
        for name in looping {
            self.drop_host(&name, ImportProblem::JumpHostLoop, issues);
        }
    }

    fn drop_unreachable(&mut self, issues: &mut Vec<ImportIssue>) {
        loop {
            let names: HashSet<&str> = self.list.iter().map(|p| p.host.name.as_str()).collect();
            let next = self.list.iter().find_map(|p| {
                let jump = p.host.jump_host.as_ref()?;
                (!names.contains(jump.as_str()) && self.dropped.contains(jump))
                    .then(|| (p.host.name.clone(), jump.clone()))
            });
            let Some((name, hop)) = next else { return };
            self.drop_host(&name, ImportProblem::JumpHostUnavailable { hop }, issues);
        }
    }
}

// --- Reading the real files ------------------------------------------------

/// Resolves `Include` patterns on the file system the way `ssh` does for the
/// user's config: relative to `~/.ssh`, `~` expanded, `*`/`?` globbed in the
/// file name.
pub struct FsIncludes {
    pub home: PathBuf,
}

impl FsIncludes {
    pub fn resolve(&self, pattern: &str) -> Result<Vec<IncludedFile>, String> {
        let path = if let Some(rest) = pattern.strip_prefix("~/") {
            self.home.join(rest)
        } else if Path::new(pattern).is_absolute() {
            PathBuf::from(pattern)
        } else {
            self.home.join(".ssh").join(pattern)
        };
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
        let dir = path.parent().map(Path::to_path_buf);
        let (Some(name), Some(dir)) = (name, dir) else {
            return Ok(Vec::new());
        };
        let mut paths = if name.contains(['*', '?']) {
            match fs::read_dir(&dir) {
                Ok(entries) => entries
                    .filter_map(Result::ok)
                    .map(|e| e.path())
                    .filter(|p| {
                        p.is_file()
                            && p.file_name()
                                .is_some_and(|n| glob(&name, &n.to_string_lossy()))
                    })
                    .collect(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                Err(e) => return Err(format!("{pattern}: {e}")),
            }
        } else if path.exists() {
            vec![path]
        } else {
            // `ssh` ignores an Include that matches nothing.
            Vec::new()
        };
        paths.sort();
        paths
            .into_iter()
            .map(|p| {
                fs::read_to_string(&p)
                    .map(|text| IncludedFile {
                        name: p.display().to_string(),
                        text,
                    })
                    .map_err(|e| format!("{}: {e}", p.display()))
            })
            .collect()
    }
}

/// Reads and parses the user's `~/.ssh/config` under `home`; a missing file
/// is an empty config.
pub fn parse_user_config(home: &Path, ctx: &ParseContext) -> std::io::Result<ParsedConfig> {
    let path = home.join(".ssh").join("config");
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let includes = FsIncludes {
        home: home.to_path_buf(),
    };
    Ok(parse(&text, ctx, &mut |pattern| includes.resolve(pattern)))
}
