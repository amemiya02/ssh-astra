use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::net::{Ipv4Addr, Ipv6Addr};

const MAX_LINK_BYTES: usize = 4096;
const MAX_USER_BYTES: usize = 256;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub(crate) struct SshLinkTarget {
    address: String,
    port: u16,
    user: String,
}

/// Accept only the destination in an ssh:// authority. The password is dropped at ingress.
pub(super) fn parse(input: &str, local_user: Option<&str>) -> Option<SshLinkTarget> {
    if input.len() > MAX_LINK_BYTES || input.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let (scheme, authority) = input.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("ssh") || authority.contains(['/', '?', '#', '\\']) {
        return None;
    }

    let (user, endpoint) = match authority.split_once('@') {
        Some((userinfo, endpoint)) => {
            let (name, _) = userinfo.split_once(':').unwrap_or((userinfo, ""));
            if !valid_userinfo(userinfo) {
                return None;
            }
            let user = percent_decode_str(name).decode_utf8().ok()?;
            if !user
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | '-' | '\\'))
            {
                return None;
            }
            (user, endpoint)
        }
        None => (local_user?.into(), authority),
    };
    if user.is_empty()
        || user.len() > MAX_USER_BYTES
        || user.trim() != user
        || user.chars().any(char::is_control)
    {
        return None;
    }

    let (address, port) = if let Some(bracketed) = endpoint.strip_prefix('[') {
        let (address, suffix) = bracketed.split_once(']')?;
        address.parse::<Ipv6Addr>().ok()?;
        let port = if suffix.is_empty() {
            22
        } else {
            parse_port(suffix.strip_prefix(':')?)?
        };
        (address, port)
    } else {
        let (address, port) = match endpoint.split_once(':') {
            Some((address, port)) => (address, parse_port(port)?),
            None => (endpoint, 22),
        };
        if !valid_hostname(address) {
            return None;
        }
        (address, port)
    };
    Some(SshLinkTarget {
        address: address.into(),
        port,
        user: user.into_owned(),
    })
}

fn valid_userinfo(input: &str) -> bool {
    let mut bytes = input.bytes();
    while let Some(c) = bytes.next() {
        match c {
            b'%' => {
                if !(0..2).all(|_| bytes.next().is_some_and(|b| b.is_ascii_hexdigit())) {
                    return false;
                }
            }
            b'-' | b'.' | b'_' | b'~' | b'!' | b'$' | b'&' | b'\'' | b'(' | b')' | b'*' | b'+'
            | b',' | b';' | b'=' | b':' => {}
            _ if c.is_ascii_alphanumeric() => {}
            _ => return false,
        }
    }
    true
}

fn valid_hostname(address: &str) -> bool {
    let hostname = address.strip_suffix('.').unwrap_or(address);
    if hostname.len() > 253 {
        return false;
    }
    if hostname.contains('.') && hostname.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return hostname.parse::<Ipv4Addr>().is_ok();
    }
    hostname.split('.').all(|label| {
        (1..=63).contains(&label.len())
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

fn parse_port(input: &str) -> Option<u16> {
    if !input.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    input.parse().ok().filter(|&port| port > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_username_and_port() {
        assert_eq!(
            parse("ssh://deploy@example.test:2222", None),
            Some(SshLinkTarget {
                address: "example.test".into(),
                port: 2222,
                user: "deploy".into(),
            })
        );
    }

    #[test]
    fn supplies_the_local_user_and_default_port() {
        assert_eq!(
            parse("SSH://example.test", Some("Local User")),
            Some(SshLinkTarget {
                address: "example.test".into(),
                port: 22,
                user: "Local User".into(),
            })
        );
    }

    #[test]
    fn parses_bracketed_ipv6_and_discards_passwords() {
        let target = parse(
            "ssh://%64eploy:discard%40this%3Apassword@[2001:db8::1]:2222",
            None,
        )
        .unwrap();
        assert_eq!(target.address, "2001:db8::1");
        assert_eq!(target.port, 2222);
        assert_eq!(target.user, "deploy");
        assert_eq!(
            serde_json::to_value(&target).unwrap(),
            serde_json::json!({"address": "2001:db8::1", "port": 2222, "user": "deploy"})
        );
    }

    #[test]
    fn rejects_invalid_and_unsupported_links() {
        for input in [
            "https://example.test",
            "ssh:example.test",
            "ssh:///example.test",
            "ssh://",
            "ssh://example.test/",
            "ssh://example.test/path",
            "ssh://example.test?command=example",
            "ssh://example.test#example",
            "ssh://example.test:0",
            "ssh://example.test:65536",
            "ssh://example.test:",
            "ssh://example.test:+22",
            "ssh://2001:db8::1",
            "ssh://[example.test]",
            "ssh://[fe80::1%25eth0]",
            "ssh://123.999.0.1",
            "ssh://-option.example",
            "ssh://@example.test",
            "ssh://user%0d@example.test",
            "ssh://user%40example.test@example.test",
            "ssh://user%ZZ@example.test",
            "ssh://user:bad@extra@example.test",
            "ssh://user:bad%ZZ@example.test",
            "ssh://user@example.test\\other",
            "ssh://user@%65xample.test",
            "\tssh://example.test",
        ] {
            assert!(parse(input, Some("local")).is_none(), "{input}");
        }
        assert!(parse(
            &format!("ssh://user:{}@example.test", "x".repeat(4096)),
            None
        )
        .is_none());
    }
}
