//! User-configured outbound proxies. Passwords are kept in the credential vault.

use std::net::IpAddr;

use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProxyKind {
    Socks5,
    HttpConnect,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub kind: ProxyKind,
    pub address: String,
    pub port: u16,
    /// An absent username uses the proxy without authentication.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

/// Which proxy to use if this Host is the first hop of its SSH route.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", content = "config", rename_all = "camelCase")]
pub enum HostProxy {
    #[default]
    Inherit,
    Direct,
    Override(ProxyConfig),
}

impl HostProxy {
    pub(crate) fn is_inherit(&self) -> bool {
        matches!(self, Self::Inherit)
    }

    pub(crate) fn normalize(self) -> Result<Self, &'static str> {
        match self {
            Self::Override(config) => config.normalize().map(Self::Override),
            other => Ok(other),
        }
    }
}

impl ProxyConfig {
    pub(crate) fn normalize(mut self) -> Result<Self, &'static str> {
        self.address = endpoint_host(self.address.trim()).ok_or("proxyAddress")?;
        if self.port == 0 {
            return Err("proxyPort");
        }
        self.username = self.username.filter(|name| !name.is_empty());
        if let Some(name) = &self.username {
            let valid = name.len() <= self.credential_limit()
                && !name.chars().any(char::is_control)
                && !(self.kind == ProxyKind::HttpConnect && name.contains(':'));
            if !valid {
                return Err("proxyUsername");
            }
        }
        Ok(self)
    }

    pub(crate) fn credential_limit(&self) -> usize {
        match self.kind {
            ProxyKind::Socks5 => 255,
            ProxyKind::HttpConnect => 4096,
        }
    }
}

/// A malformed configured proxy stays configured, so it can't accidentally
/// become a direct connection when a hand-edited setting fails to parse.
pub(crate) fn deserialize_global_proxy<'de, D>(
    deserializer: D,
) -> Result<Option<ProxyConfig>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(raw.map(|value| {
        serde_json::from_value(value).unwrap_or_else(|_| ProxyConfig {
            kind: ProxyKind::Socks5,
            address: String::new(),
            port: 0,
            username: None,
        })
    }))
}

/// Normalizes a hostname or IP literal, rejecting anything that could change
/// the structure of an HTTP authority or the target sent to a proxy.
pub(crate) fn endpoint_host(raw: &str) -> Option<String> {
    if let Some(ipv6) = raw.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        return ipv6
            .parse::<std::net::Ipv6Addr>()
            .ok()
            .map(|ip| ip.to_string());
    }
    if let Ok(ip) = raw.parse::<IpAddr>() {
        return Some(ip.to_string());
    }
    let name = raw.strip_suffix('.').unwrap_or(raw);
    if name.len() > 253
        || !name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        })
    {
        return None;
    }
    Some(raw.to_ascii_lowercase())
}
