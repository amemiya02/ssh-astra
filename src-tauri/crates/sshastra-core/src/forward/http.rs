//! HTTP CONNECT proxy for a local Port forward. The SSH server resolves the
//! requested destination and opens the TCP connection.

use std::net::{Ipv6Addr, SocketAddr};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use crate::ssh::Connection;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_HEAD_BYTES: u64 = 8 * 1024;
const MAX_HEADERS: usize = 64;

const CONNECTED: &[u8] = b"HTTP/1.1 200 Connection Established\r\n\r\n";
const BAD_REQUEST: &[u8] =
    b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const METHOD_NOT_ALLOWED: &[u8] =
    b"HTTP/1.1 405 Method Not Allowed\r\nAllow: CONNECT\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const REQUEST_TIMEOUT: &[u8] =
    b"HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const HEAD_TOO_LARGE: &[u8] =
    b"HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const BAD_GATEWAY: &[u8] =
    b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

pub(super) async fn serve(socket: TcpStream, peer: SocketAddr, connection: &Connection) {
    let _ = socket.set_nodelay(true);
    // Keep any tunnel bytes buffered past the HTTP head for copy_bidirectional.
    let mut socket = BufReader::new(socket);
    let request = tokio::time::timeout(HANDSHAKE_TIMEOUT, destination(&mut socket))
        .await
        .unwrap_or(Err(REQUEST_TIMEOUT));
    let (host, port) = match request {
        Ok(target) => target,
        Err(reply) => {
            let _ = socket.write_all(reply).await;
            return;
        }
    };
    let Ok(mut channel) = connection.open_direct_tcpip(&host, port, Some(peer)).await else {
        let _ = socket.write_all(BAD_GATEWAY).await;
        return;
    };
    if socket.write_all(CONNECTED).await.is_ok() {
        let _ = tokio::io::copy_bidirectional(&mut socket, &mut channel).await;
    }
}

async fn destination(socket: &mut BufReader<TcpStream>) -> Result<(String, u16), &'static [u8]> {
    let mut reader = socket.take(MAX_HEAD_BYTES);
    let mut head = Vec::new();
    loop {
        let start = head.len();
        reader
            .read_until(b'\n', &mut head)
            .await
            .map_err(|_| BAD_REQUEST)?;
        let line = &head[start..];
        if line == b"\r\n" {
            break;
        }
        if !line.ends_with(b"\r\n") {
            return Err(if reader.limit() == 0 {
                HEAD_TOO_LARGE
            } else {
                BAD_REQUEST
            });
        }
    }
    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut request = httparse::Request::new(&mut headers);
    match request.parse(&head) {
        Ok(httparse::Status::Complete(end)) if end == head.len() => {}
        Err(httparse::Error::TooManyHeaders) => return Err(HEAD_TOO_LARGE),
        _ => return Err(BAD_REQUEST),
    }
    if request.method != Some("CONNECT") {
        return Err(METHOD_NOT_ALLOWED);
    }
    if request
        .headers
        .iter()
        .any(|h| h.name.eq_ignore_ascii_case("transfer-encoding"))
    {
        return Err(BAD_REQUEST);
    }
    let mut lengths = request
        .headers
        .iter()
        .filter(|h| h.name.eq_ignore_ascii_case("content-length"));
    if lengths.next().is_some_and(|h| h.value != b"0") || lengths.next().is_some() {
        return Err(BAD_REQUEST);
    }
    request
        .path
        .and_then(authority)
        .map(|(host, port)| (host.to_owned(), port))
        .ok_or(BAD_REQUEST)
}

/// Accept a DNS name or IPv4 address, or a bracketed IPv6 address, followed
/// by an explicit decimal port. Brackets are omitted in the SSH request.
fn authority(target: &str) -> Option<(&str, u16)> {
    let (host, port) = target.rsplit_once(':')?;
    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let port = port.parse::<u16>().ok().filter(|port| *port != 0)?;
    if let Some(ip) = host.strip_prefix('[').and_then(|ip| ip.strip_suffix(']')) {
        ip.parse::<Ipv6Addr>().ok()?;
        return Some((ip, port));
    }
    let name = host.strip_suffix('.').unwrap_or(host);
    let valid = name.len() <= 253
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        });
    valid.then_some((host, port))
}
