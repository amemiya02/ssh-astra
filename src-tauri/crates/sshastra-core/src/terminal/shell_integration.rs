//! ShellIntegration: lets a remote Terminal tell the app its shell's current
//! directory, so the File panel can follow `cd`.
//!
//! - [`INJECTION`] is typed into a new bash or zsh shell once it shows its
//!   first prompt (never written to the remote rc files). It adds a prompt
//!   hook that reports `$PWD` with OSC 7
//!   (`ESC ] 7 ; file://host/percent-encoded-path BEL`) before every prompt,
//!   then prints a ready marker. Other shells only print the marker.
//! - [`ShellOutput`] hides the shell's output from the injection to that
//!   marker (the echoed line, the repeated prompt) and finds the directory
//!   reports ([`CwdParser`]). Reports stay in the output: terminal emulators
//!   ignore OSC 7.
//! - [`REPORT_CWD`] asks any POSIX-ish shell for one report, for shells the
//!   injection does not cover (the File panel's "sync" button).

/// Typed into a new remote shell when ShellIntegration is on. The leading
/// space keeps it out of history where the shell ignores such lines (bash's
/// `ignorespace`, zsh's `HIST_IGNORE_SPACE`). One line, short enough for any
/// canonical-mode line buffer.
pub const INJECTION: &str = concat!(
    " [ -n \"$BASH_VERSION\" ] && eval '",
    "__sshastra_osc7(){ local LC_ALL=C s=$PWD o= c i;",
    " for ((i=0;i<${#s};i++)); do c=${s:i:1};",
    " case $c in [-/._~A-Za-z0-9]) o+=$c;; *) printf -v c %%%02X \"'\\''$c\"; o+=$c;; esac;",
    " done; printf \"\\e]7;file://%s%s\\a\" \"$HOSTNAME\" \"$o\"; };",
    " PROMPT_COMMAND=\"__sshastra_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"';",
    " [ -n \"$ZSH_VERSION\" ] && eval '",
    "__sshastra_osc7(){ emulate -L zsh; setopt extendedglob; local LC_ALL=C;",
    " printf \"\\e]7;file://%s%s\\a\" \"$HOST\"",
    " \"${PWD//(#m)[^-\\/._~A-Za-z0-9]/%${(l:2::0:)$(([##16]#MATCH))}}\"; };",
    " autoload -Uz add-zsh-hook; add-zsh-hook precmd __sshastra_osc7';",
    " printf '\\033]6973;ready\\007'\r",
);

/// The OSC payload [`INJECTION`] prints when it is done.
const READY: &[u8] = b"6973;ready";

/// Typed into the Terminal (visibly) to make the shell report its directory
/// once, when ShellIntegration is off or the shell is not bash/zsh.
pub const REPORT_CWD: &str = " printf '\\033]7;file://%s%s\\007' \"$(hostname)\" \"$PWD\"\r";

/// One remote shell's output on its way to the screen.
#[derive(Debug, Default)]
pub struct ShellOutput {
    parser: CwdParser,
    /// Output held back since [`Self::hide_until_ready`]; `None` when shown.
    held: Option<Vec<u8>>,
}

/// What to show of a chunk of output, and the directories it reported.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Shown {
    pub output: Vec<u8>,
    pub cwds: Vec<String>,
}

impl ShellOutput {
    /// Holds back all output until the [`INJECTION`] ready marker: the
    /// screen keeps the prompt the line was typed at, and the cursor goes
    /// back to its start so the next prompt replaces it.
    pub fn hide_until_ready(&mut self) {
        self.held = Some(Vec::new());
    }

    pub fn is_hiding(&self) -> bool {
        self.held.is_some()
    }

    /// Stops hiding without the marker (the shell never printed it) and
    /// returns what was held back.
    pub fn reveal(&mut self) -> Vec<u8> {
        self.held.take().unwrap_or_default()
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Shown {
        let mut cwds = Vec::new();
        let mut ready_at = None;
        self.parser.scan(bytes, |end, payload| {
            if payload == READY {
                ready_at.get_or_insert(end);
            } else if let Some(cwd) = cwd_from_osc(payload) {
                cwds.push(cwd);
            }
        });
        let output = match (&mut self.held, ready_at) {
            (None, _) => bytes.to_vec(),
            (Some(_), Some(end)) => {
                self.held = None;
                [b"\r\x1b[K", &bytes[end..]].concat()
            }
            (Some(held), None) => {
                held.extend_from_slice(bytes);
                Vec::new()
            }
        };
        Shown { output, cwds }
    }
}

/// The longest OSC payload kept; longer ones are dropped.
const MAX_PAYLOAD: usize = 8192;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum State {
    #[default]
    Ground,
    Esc,
    /// Inside `ESC ]`, collecting the payload.
    Osc,
    /// Saw ESC inside an OSC: `\` ends it, anything else aborts it.
    OscEsc,
}

/// Finds OSC 7 directory reports in a Terminal's output, which may arrive cut
/// at any byte. Keeps only the unfinished sequence between calls.
#[derive(Debug, Default)]
pub struct CwdParser {
    state: State,
    payload: Vec<u8>,
    overflow: bool,
}

impl CwdParser {
    /// Scans the next chunk of output; returns the directories reported in
    /// it, in order.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut found = Vec::new();
        self.scan(bytes, |_, payload| found.extend(cwd_from_osc(payload)));
        found
    }

    /// Calls `on_osc(end, payload)` for every OSC sequence that ends in
    /// `bytes`, `end` being the index just past it.
    fn scan(&mut self, bytes: &[u8], mut on_osc: impl FnMut(usize, &[u8])) {
        for (i, &b) in bytes.iter().enumerate() {
            self.state = match (self.state, b) {
                (State::Ground, ESC) => State::Esc,
                (State::Ground, _) => State::Ground,
                // After an unterminated OSC, `ESC ]` starts a new one.
                (State::Esc | State::OscEsc, b']') => {
                    self.payload.clear();
                    self.overflow = false;
                    State::Osc
                }
                (State::Esc | State::OscEsc, ESC) => State::Esc,
                (State::Osc, BEL) | (State::OscEsc, b'\\') => {
                    if !self.overflow {
                        on_osc(i + 1, &self.payload);
                    }
                    self.payload.clear();
                    State::Ground
                }
                (State::Esc | State::OscEsc, _) => State::Ground,
                (State::Osc, ESC) => State::OscEsc,
                // CAN and SUB cancel the sequence.
                (State::Osc, 0x18 | 0x1a) => State::Ground,
                (State::Osc, _) => {
                    if self.payload.len() < MAX_PAYLOAD {
                        self.payload.push(b);
                    } else {
                        self.overflow = true;
                    }
                    State::Osc
                }
            };
        }
    }
}

/// The directory in an OSC payload `7;file://host/path`, if it is one.
fn cwd_from_osc(payload: &[u8]) -> Option<String> {
    let url = payload.strip_prefix(b"7;")?.strip_prefix(b"file://")?;
    let path = &url[url.iter().position(|&b| b == b'/')?..];
    Some(String::from_utf8_lossy(&percent_decode(path)).into_owned())
}

fn percent_decode(input: &[u8]) -> Vec<u8> {
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'%' && i + 2 < input.len() {
            if let (Some(hi), Some(lo)) = (hex(input[i + 1]), hex(input[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(input[i]);
        i += 1;
    }
    out
}
