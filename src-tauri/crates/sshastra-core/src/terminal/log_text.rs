use encoding_rs::{CoderResult, Decoder, UTF_8};

/// A bounded transformation of Terminal output into plain text. Keep a pending
/// line so a carriage return can move to its beginning and overwrite it.
/// Very long lines emit their prefix to bound the amount of editable text.
pub struct TerminalLogText {
    decoder: Decoder,
    escape: Escape,
    line: Vec<char>,
    column: usize,
}

const MAX_PENDING_CHARS: usize = 16 * 1024;

#[derive(Default, PartialEq, Eq)]
enum Escape {
    #[default]
    Ground,
    Start,
    Intermediate,
    Csi(Option<u8>),
    Osc,
    String,
    OscEnd,
    StringEnd,
}

impl Default for TerminalLogText {
    fn default() -> Self {
        Self {
            decoder: UTF_8.new_decoder_without_bom_handling(),
            escape: Escape::Ground,
            line: Vec::new(),
            column: 0,
        }
    }
}

impl TerminalLogText {
    /// Appends completed text to `output`. Chunks may end anywhere, including
    /// within UTF-8 characters, control sequences or CRLF.
    pub fn feed(&mut self, bytes: &[u8], output: &mut String) {
        self.decode(bytes, output, false);
    }

    /// Appends the pending line and resets the parser for a fresh shell.
    pub fn finish(&mut self, output: &mut String) {
        self.decode(&[], output, true);
        self.emit_line(output);
        self.decoder = UTF_8.new_decoder_without_bom_handling();
        self.escape = Escape::Ground;
    }

    fn decode(&mut self, mut bytes: &[u8], output: &mut String, last: bool) {
        let mut decoded = [0; 4096];
        loop {
            let (result, read, written, _) = self.decoder.decode_to_utf8(bytes, &mut decoded, last);
            let text = std::str::from_utf8(&decoded[..written]).expect("UTF-8 decoder output");
            for character in text.chars() {
                self.consume(character, output);
            }
            if result == CoderResult::InputEmpty {
                break;
            }
            bytes = &bytes[read..];
        }
    }

    fn consume(&mut self, ch: char, output: &mut String) {
        use Escape::*;
        self.escape = match self.escape {
            Osc if ch == '\x1b' => OscEnd,
            String if ch == '\x1b' => StringEnd,
            Osc | OscEnd if matches!(ch, '\x07' | '\u{9c}') => Ground,
            String | StringEnd if ch == '\u{9c}' => Ground,
            OscEnd | StringEnd if ch == '\\' => Ground,
            Osc | OscEnd if !matches!(ch, '\x18' | '\x1a') => {
                if ch == '\x1b' {
                    OscEnd
                } else {
                    Osc
                }
            }
            String | StringEnd if !matches!(ch, '\x18' | '\x1a') => {
                if ch == '\x1b' {
                    StringEnd
                } else {
                    String
                }
            }
            _ if matches!(ch, '\x18' | '\x1a') => Ground,
            _ if ch == '\x1b' => Start,
            Ground => match ch {
                '\u{9b}' => Csi(None),
                '\u{9d}' => Osc,
                '\u{90}' | '\u{98}' | '\u{9e}' | '\u{9f}' => String,
                _ => {
                    self.print(ch, output);
                    Ground
                }
            },
            Start => match ch {
                '[' => Csi(None),
                ']' => Osc,
                'P' | 'X' | '^' | '_' => String,
                ' '..='/' => Intermediate,
                _ => Ground,
            },
            Intermediate if matches!(ch, ' '..='/') => Intermediate,
            Csi(parameter) if matches!(ch, '@'..='~') => {
                if ch == 'K' {
                    match parameter {
                        None | Some(b'0') => self.line.truncate(self.column),
                        Some(b'2') => {
                            self.line.clear();
                            self.column = 0;
                        }
                        _ => {}
                    }
                }
                Ground
            }
            Csi(None) if ch.is_ascii_digit() => Csi(Some(ch as u8)),
            Csi(_) if matches!(ch, ' '..='?') => Csi(Some(b'?')),
            _ => Ground,
        };
    }

    fn print(&mut self, ch: char, output: &mut String) {
        match ch {
            '\r' => self.column = 0,
            '\x08' => self.column = self.column.saturating_sub(1),
            '\n' => {
                self.emit_line(output);
                output.push('\n');
            }
            _ if !ch.is_control() || ch == '\t' => {
                if self.column == MAX_PENDING_CHARS {
                    self.emit_line(output);
                }
                if self.column == self.line.len() {
                    self.line.push(ch);
                } else {
                    self.line[self.column] = ch;
                }
                self.column += 1;
            }
            _ => {}
        }
    }

    fn emit_line(&mut self, output: &mut String) {
        output.extend(self.line.iter().copied());
        self.line.clear();
        self.column = 0;
    }
}
