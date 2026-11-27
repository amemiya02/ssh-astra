use std::collections::HashMap;
use std::iter::Peekable;
use std::str::Chars;

use super::{ConfigHost, ImportIssue, ImportProblem, ParsedConfig};

/// Parses a Host CSV with a header. Name, Address, and Username are required.
/// Port defaults to 22, Group uses `/` for nesting, and other columns are ignored.
pub fn parse_csv(text: &str) -> ParsedConfig {
    let mut records = Records {
        input: text.trim_start_matches('\u{feff}').chars().peekable(),
        line: 1,
    }
    .filter(|(_, fields)| {
        !matches!(fields, Ok(fields) if fields.len() == 1 && fields[0].trim().is_empty())
    });
    let mut parsed = ParsedConfig::default();
    let Some((line, header)) = records.next() else {
        return parsed;
    };
    let columns = header.and_then(|fields| Columns::read(&fields));
    let columns = match columns {
        Ok(columns) => columns,
        Err(problem) => {
            parsed.issues.push(issue(line, problem));
            return parsed;
        }
    };
    for (line, fields) in records {
        match fields.and_then(|fields| columns.host(&fields)) {
            Ok(host) => parsed.hosts.push(host),
            Err(problem) => parsed.issues.push(issue(line, problem)),
        }
    }
    parsed
}

fn issue(line: usize, problem: ImportProblem) -> ImportIssue {
    ImportIssue {
        entry: String::new(),
        line: Some(line),
        dropped: true,
        problem,
    }
}

struct Columns {
    name: usize,
    address: usize,
    username: usize,
    port: Option<usize>,
    group: Option<usize>,
}

impl Columns {
    fn read(fields: &[String]) -> Result<Self, ImportProblem> {
        let mut columns = HashMap::new();
        for (index, field) in fields.iter().enumerate() {
            let name = field.trim().to_ascii_lowercase();
            if matches!(
                name.as_str(),
                "name" | "address" | "username" | "port" | "group"
            ) && columns.insert(name, index).is_some()
            {
                return Err(ImportProblem::CsvHeaders);
            }
        }
        let required = |field| columns.get(field).copied().ok_or(ImportProblem::CsvHeaders);
        Ok(Self {
            name: required("name")?,
            address: required("address")?,
            username: required("username")?,
            port: columns.get("port").copied(),
            group: columns.get("group").copied(),
        })
    }

    fn host(&self, fields: &[String]) -> Result<ConfigHost, ImportProblem> {
        let field = |index| {
            fields
                .get(index)
                .map(String::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        };
        let required =
            |index, name| field(index).ok_or(ImportProblem::CsvMissingField { field: name });
        let name = required(self.name, "Name")?;
        let address = required(self.address, "Address")?;
        let user = required(self.username, "Username")?;
        let port = match self.port.and_then(field) {
            None => 22,
            Some(value) => value
                .parse::<u16>()
                .ok()
                .filter(|&port| port > 0 && value.bytes().all(|byte| byte.is_ascii_digit()))
                .ok_or(ImportProblem::CsvInvalidPort)?,
        };
        let group_path: Vec<_> = self
            .group
            .and_then(field)
            .into_iter()
            .flat_map(|value| value.split('/').map(|part| part.trim().to_owned()))
            .collect();
        if group_path.iter().any(String::is_empty) {
            return Err(ImportProblem::CsvInvalidGroup);
        }
        Ok(ConfigHost {
            name: name.to_owned(),
            address: address.to_owned(),
            port,
            user: user.to_owned(),
            identity_file: None,
            identities_only: false,
            forward_agent: false,
            keepalive_seconds: None,
            jump_host: None,
            proxy_command: None,
            forwards: Vec::new(),
            group_path,
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FieldState {
    Start,
    Unquoted,
    Quoted,
    ClosedQuote,
}

struct Records<'a> {
    input: Peekable<Chars<'a>>,
    line: usize,
}

impl Iterator for Records<'_> {
    type Item = (usize, Result<Vec<String>, ImportProblem>);

    fn next(&mut self) -> Option<Self::Item> {
        self.input.peek()?;
        let line = self.line;
        let mut fields = Vec::new();
        let mut field = String::new();
        let mut state = FieldState::Start;
        let mut malformed = false;
        loop {
            let mut next = self.input.next();
            if matches!(next, Some('\r' | '\n')) {
                self.line += 1;
                if next == Some('\r') && self.input.next_if_eq(&'\n').is_some() {
                    if state == FieldState::Quoted {
                        field.push('\r');
                    }
                    next = Some('\n');
                }
            }
            match (state, next) {
                (FieldState::Quoted, Some('"')) => {
                    if self.input.next_if_eq(&'"').is_some() {
                        field.push('"');
                    } else {
                        state = FieldState::ClosedQuote;
                    }
                }
                (FieldState::Quoted, Some(ch)) => field.push(ch),
                (FieldState::Quoted, None) => {
                    return Some((line, Err(ImportProblem::CsvMalformedRecord)))
                }
                (_, Some(',')) => {
                    fields.push(std::mem::take(&mut field));
                    state = FieldState::Start;
                }
                (_, Some('\r' | '\n') | None) => {
                    fields.push(field);
                    return Some((
                        line,
                        if malformed {
                            Err(ImportProblem::CsvMalformedRecord)
                        } else {
                            Ok(fields)
                        },
                    ));
                }
                (FieldState::Start, Some('"')) => state = FieldState::Quoted,
                (FieldState::ClosedQuote, Some(_)) | (FieldState::Unquoted, Some('"')) => {
                    malformed = true;
                    state = FieldState::Unquoted;
                }
                (_, Some(ch)) => {
                    field.push(ch);
                    state = FieldState::Unquoted;
                }
            }
        }
    }
}
