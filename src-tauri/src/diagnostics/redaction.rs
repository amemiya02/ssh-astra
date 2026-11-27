use std::cmp::Reverse;
use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::net::IpAddr;
use std::sync::LazyLock;

use regex::Regex;

static IP_CANDIDATES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i:[0-9a-f.]*:[0-9a-f:.]*:[0-9a-f:.]*)(?:%[\w.~\-]+)?|(?:[0-9]{1,3}\.){3}[0-9]{1,3}",
    )
    .expect("IP candidate pattern is valid")
});

struct Match<'a> {
    start: usize,
    end: usize,
    original: &'a str,
}

/// Replaces complete configured values and IP literals with codes allocated in
/// order of first appearance. Raw and JSON-escaped forms share a code.
pub(super) fn redact<'a>(
    log: &str,
    sensitive: impl IntoIterator<Item = &'a str>,
) -> Result<String, regex::Error> {
    let mut literals = BTreeMap::new();
    for value in sensitive.into_iter().filter(|value| !value.is_empty()) {
        let escaped = serde_json::to_string(value).expect("a string serializes to JSON");
        literals.insert(escaped[1..escaped.len() - 1].to_owned(), value);
        literals.insert(value.to_owned(), value);
    }
    let mut matches = Vec::new();
    if !literals.is_empty() {
        let mut pattern = literals.keys().collect::<Vec<_>>();
        pattern.sort_by_key(|text| Reverse(text.len()));
        let pattern = pattern
            .iter()
            .map(|text| regex::escape(text))
            .collect::<Vec<_>>()
            .join("|");
        for found in Regex::new(&pattern)?.find_iter(log) {
            if complete_token(log, found.start(), found.end()) {
                matches.push(Match {
                    start: found.start(),
                    end: found.end(),
                    original: literals[found.as_str()],
                });
            }
        }
    }
    for found in IP_CANDIDATES.find_iter(log) {
        let text = found.as_str().trim_matches('.');
        let start =
            found.start() + (found.as_str().len() - found.as_str().trim_start_matches('.').len());
        let end = start + text.len();
        let address = text.split_once('%').map_or(text, |(address, _)| address);
        // An IP cannot be part of a word, even when it starts or ends with `::`.
        if address.parse::<IpAddr>().is_ok()
            && !log[..start].chars().next_back().is_some_and(word_char)
            && !log[end..].chars().next().is_some_and(word_char)
        {
            matches.push(Match {
                start,
                end,
                original: text,
            });
        }
    }

    matches.sort_by_key(|found| (found.start, Reverse(found.end)));
    let mut codes = HashMap::new();
    let mut result = String::with_capacity(log.len());
    let mut offset = 0;
    for found in matches {
        if found.start < offset {
            offset = offset.max(found.end);
            continue;
        }
        result.push_str(&log[offset..found.start]);
        let next = codes.len() + 1;
        let code = codes.entry(found.original).or_insert(next);
        let _ = write!(result, "⟦{code}⟧");
        offset = found.end;
    }
    result.push_str(&log[offset..]);
    Ok(result)
}

fn complete_token(log: &str, start: usize, end: usize) -> bool {
    let first = log[start..end].chars().next().is_some_and(word_char);
    let last = log[start..end].chars().next_back().is_some_and(word_char);
    !(first && log[..start].chars().next_back().is_some_and(word_char)
        || last && log[end..].chars().next().is_some_and(word_char))
}

fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn a_diagnostic_report_redacts_configured_values_and_ips_consistently() {
        let identities = [
            "Production edge",
            "edge.example.net",
            "sam",
            "Private relay",
            "relay-uuid",
            "api.internal",
            "/Users/sam/.ssh/id prod",
            "/Users/sam",
            "192.0.2.42",
        ];
        let log = "Production edge sam@edge.example.net via Private relay relay-uuid\n\
                   key=/Users/sam/.ssh/id prod home=/Users/sam forward=api.internal:5432\n\
                   repeat=sam, edge.example.net 192.0.2.42:22 then 192.0.2.42.\n\
                   ip=[2001:db8::1]:22 then 2001:db8::1 and ::ffff:192.0.2.9\n\
                   unrelated: sample time=12:30:00 version=1.2.3 src=sshastra_core::files::transfer";

        let output = redact(log, identities).unwrap();
        assert_eq!(
            output,
            "⟦1⟧ ⟦2⟧@⟦3⟧ via ⟦4⟧ ⟦5⟧\n\
                            key=⟦6⟧ home=⟦7⟧ forward=⟦8⟧:5432\n\
                            repeat=⟦2⟧, ⟦3⟧ ⟦9⟧:22 then ⟦9⟧.\n\
                            ip=[⟦10⟧]:22 then ⟦10⟧ and ⟦11⟧\n\
                            unrelated: sample time=12:30:00 version=1.2.3 src=sshastra_core::files::transfer"
        );
    }
}
