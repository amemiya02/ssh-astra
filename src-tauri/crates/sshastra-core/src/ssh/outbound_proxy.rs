//! Establishes one proxy tunnel before SSH takes ownership of the stream.

use std::io;
use std::net::IpAddr;
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use super::{ConnectError, PasswordPrompt, Prompter, CONNECT_TIMEOUT};
use crate::credentials::{CredentialKind, CredentialVault};
use crate::hosts::{Host, HostId};
use crate::proxy::{endpoint_host, ProxyConfig, ProxyKind};

const MAX_HTTP_HEAD: usize = 16 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("the outbound proxy settings are invalid")]
    InvalidConfiguration,
    #[error("the Host address is invalid for an outbound proxy")]
    InvalidTarget,
    #[error("cannot reach the outbound proxy")]
    Unreachable,
    #[error("the outbound proxy did not answer in time")]
    TimedOut,
    #[error("the outbound proxy returned an invalid or incomplete response")]
    InvalidResponse,
    #[error("the outbound proxy rejected authentication")]
    AuthenticationFailed,
    #[error("the outbound proxy refused the connection to the Host")]
    ConnectFailed,
}

impl ProxyError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::InvalidConfiguration => "proxyInvalidConfiguration",
            Self::InvalidTarget => "proxyInvalidTarget",
            Self::Unreachable => "proxyUnreachable",
            Self::TimedOut => "proxyTimedOut",
            Self::InvalidResponse => "proxyInvalidResponse",
            Self::AuthenticationFailed => "proxyAuthenticationFailed",
            Self::ConnectFailed => "proxyConnectFailed",
        }
    }
}

impl From<io::Error> for ProxyError {
    fn from(_: io::Error) -> Self {
        Self::InvalidResponse
    }
}

pub(super) struct ProxyCredentials<'a> {
    vault: &'a Arc<dyn CredentialVault>,
    owner: HostId,
    kind: CredentialKind,
    save: bool,
}

impl<'a> ProxyCredentials<'a> {
    pub(super) fn new(
        vault: &'a Arc<dyn CredentialVault>,
        host: Option<&HostId>,
        save: bool,
    ) -> Self {
        let (owner, kind) = match host {
            Some(id) => (id.clone(), CredentialKind::ProxyPassword),
            None => (
                CredentialKind::global_proxy_owner(),
                CredentialKind::GlobalProxyPassword,
            ),
        };
        Self {
            vault,
            owner,
            kind,
            save: save && vault.can_save(),
        }
    }

    async fn get(&self, config: &ProxyConfig) -> Option<String> {
        let (vault, owner, kind) = (Arc::clone(self.vault), self.owner.clone(), self.kind);
        let config = config.clone();
        tokio::task::spawn_blocking(move || {
            let entry = vault.get(&owner, kind).ok().flatten()?;
            let (stored, password): (ProxyConfig, String) = serde_json::from_str(&entry).ok()?;
            (stored == config).then_some(password)
        })
        .await
        .ok()
        .flatten()
    }

    async fn save(&self, config: &ProxyConfig, password: String) {
        // Binding the secret to its proxy prevents a change in address,
        // protocol or account from sending a previously saved password there.
        let (vault, owner, kind) = (Arc::clone(self.vault), self.owner.clone(), self.kind);
        let entry = serde_json::to_string(&(config, password)).expect("proxy entry serializes");
        let _ = tokio::task::spawn_blocking(move || vault.set(&owner, kind, &entry)).await;
    }
}

pub(super) async fn dial(
    config: ProxyConfig,
    host: &Host,
    credentials: ProxyCredentials<'_>,
    prompter: &dyn Prompter,
) -> Result<BufReader<TcpStream>, ConnectError> {
    let config = config
        .normalize()
        .map_err(|_| ProxyError::InvalidConfiguration)?;
    let target = endpoint_host(&host.address)
        .filter(|_| host.port != 0)
        .ok_or(ProxyError::InvalidTarget)?;
    let Some(username) = &config.username else {
        return Ok(tunnel(&config, &target, host.port, None).await?);
    };

    let retry = if let Some(saved) = credentials.get(&config).await {
        match tunnel(&config, &target, host.port, Some((username, &saved))).await {
            Err(ProxyError::AuthenticationFailed) => true,
            result => return Ok(result?),
        }
    } else {
        false
    };
    let secret = prompter
        .proxy_password(PasswordPrompt {
            host: authority(&config.address, config.port),
            user: username.clone(),
            retry,
            can_save: credentials.save,
        })
        .await
        .ok_or(if retry {
            ProxyError::AuthenticationFailed.into()
        } else {
            ConnectError::Cancelled
        })?;
    let stream = tunnel(&config, &target, host.port, Some((username, &secret.value))).await?;
    if credentials.save && secret.save {
        credentials.save(&config, secret.value).await;
    }
    Ok(stream)
}

async fn tunnel(
    config: &ProxyConfig,
    target: &str,
    port: u16,
    login: Option<(&str, &str)>,
) -> Result<BufReader<TcpStream>, ProxyError> {
    if login.is_some_and(|(_, password)| {
        password.len() > config.credential_limit()
            || (config.kind == ProxyKind::Socks5 && password.is_empty())
    }) {
        return Err(ProxyError::AuthenticationFailed);
    }

    tokio::time::timeout(CONNECT_TIMEOUT, async {
        let tcp = TcpStream::connect((config.address.as_str(), config.port))
            .await
            .map_err(|_| ProxyError::Unreachable)?;
        let _ = tcp.set_nodelay(true);
        // Keep the buffer for SSH, since the proxy can forward the beginning
        // of the SSH identification line in the same read as its reply.
        let mut stream = BufReader::new(tcp);
        match config.kind {
            ProxyKind::Socks5 => socks5(&mut stream, target, port, login).await?,
            ProxyKind::HttpConnect => http_connect(&mut stream, target, port, login).await?,
        }
        Ok(stream)
    })
    .await
    .map_err(|_| ProxyError::TimedOut)?
}

type Stream = BufReader<TcpStream>;

async fn socks5(
    stream: &mut Stream,
    target: &str,
    port: u16,
    login: Option<(&str, &str)>,
) -> Result<(), ProxyError> {
    let method = if login.is_some() { 2 } else { 0 };
    stream.write_all(&[5, 1, method]).await?;
    let mut choice = [0; 2];
    stream.read_exact(&mut choice).await?;
    match choice {
        [5, 0xff] => return Err(ProxyError::AuthenticationFailed),
        [5, selected] if selected == method => {}
        _ => return Err(ProxyError::InvalidResponse),
    }
    if let Some((username, password)) = login {
        let mut request = Vec::with_capacity(3 + username.len() + password.len());
        request.extend([1, username.len() as u8]);
        request.extend(username.as_bytes());
        request.push(password.len() as u8);
        request.extend(password.as_bytes());
        stream.write_all(&request).await?;
        let mut result = [0; 2];
        stream.read_exact(&mut result).await?;
        match result {
            [1, 0] => {}
            [1, _] => return Err(ProxyError::AuthenticationFailed),
            _ => return Err(ProxyError::InvalidResponse),
        }
    }

    let mut request = vec![5, 1, 0];
    match target.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            request.push(1);
            request.extend(ip.octets());
        }
        Ok(IpAddr::V6(ip)) => {
            request.push(4);
            request.extend(ip.octets());
        }
        Err(_) => {
            request.extend([3, target.len() as u8]);
            request.extend(target.as_bytes());
        }
    }
    request.extend(port.to_be_bytes());
    stream.write_all(&request).await?;

    let mut head = [0; 4];
    stream.read_exact(&mut head).await?;
    let [5, reply, 0, address_type] = head else {
        return Err(ProxyError::InvalidResponse);
    };
    if reply != 0 {
        return Err(ProxyError::ConnectFailed);
    }
    let address_len = match address_type {
        1 => 4,
        4 => 16,
        3 => match stream.read_u8().await? {
            0 => return Err(ProxyError::InvalidResponse),
            len => usize::from(len),
        },
        _ => return Err(ProxyError::InvalidResponse),
    };
    stream.read_exact(&mut [0; 257][..address_len + 2]).await?;
    Ok(())
}

fn authority(address: &str, port: u16) -> String {
    if address.contains(':') {
        format!("[{address}]:{port}")
    } else {
        format!("{address}:{port}")
    }
}

async fn http_connect(
    stream: &mut Stream,
    target: &str,
    port: u16,
    login: Option<(&str, &str)>,
) -> Result<(), ProxyError> {
    let target = authority(target, port);
    let mut request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let Some((username, password)) = login {
        let auth = STANDARD.encode(format!("{username}:{password}"));
        request.push_str("Proxy-Authorization: Basic ");
        request.push_str(&auth);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await?;

    let mut reply = stream.take(MAX_HTTP_HEAD as u64);
    let mut line = Vec::new();
    loop {
        reply.read_until(b'\n', &mut line).await?;
        let status = http_status(&line).ok_or(ProxyError::InvalidResponse)?;
        loop {
            line.clear();
            reply.read_until(b'\n', &mut line).await?;
            if line == b"\r\n" {
                break;
            }
            if !http_header(&line) {
                return Err(ProxyError::InvalidResponse);
            }
        }
        match status {
            101 => return Err(ProxyError::InvalidResponse),
            100..=199 => line.clear(),
            200..=299 => return Ok(()),
            407 => return Err(ProxyError::AuthenticationFailed),
            _ => return Err(ProxyError::ConnectFailed),
        }
    }
}

fn http_status(line: &[u8]) -> Option<u16> {
    let line = line.strip_suffix(b"\r\n")?;
    let line = line
        .strip_prefix(b"HTTP/1.1 ")
        .or_else(|| line.strip_prefix(b"HTTP/1.0 "))?;
    let [a, b, c, rest @ ..] = line else {
        return None;
    };
    if [a, b, c].iter().all(|digit| digit.is_ascii_digit())
        && (rest.is_empty() || rest[0] == b' ')
        && rest.iter().all(|byte| valid_field_byte(*byte))
    {
        Some(u16::from(a - b'0') * 100 + u16::from(b - b'0') * 10 + u16::from(c - b'0'))
    } else {
        None
    }
}

fn http_header(line: &[u8]) -> bool {
    let Some(line) = line.strip_suffix(b"\r\n") else {
        return false;
    };
    let Some(colon) = line.iter().position(|&byte| byte == b':') else {
        return false;
    };
    let name = &line[..colon];
    !name.is_empty()
        && name
            .iter()
            .all(|&byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^`_|~".contains(&byte))
        && line[colon + 1..].iter().all(|byte| valid_field_byte(*byte))
}

fn valid_field_byte(byte: u8) -> bool {
    byte == b'\t' || (byte >= b' ' && byte != 127)
}
