//! The SOCKS5 side of a dynamic forward (`ssh -D`): the CONNECT command with
//! no authentication (RFC 1928), each destination opened by the server as a
//! `direct-tcpip` channel. Names are resolved by the server, as with `ssh -D`.

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::ssh::Connection;

/// How long a client gets to say where it wants to go.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

const VERSION: u8 = 5;
const NO_AUTH: u8 = 0;
const NO_ACCEPTABLE_METHOD: u8 = 0xff;
const CONNECT: u8 = 1;

// Reply codes.
const SUCCEEDED: u8 = 0;
const GENERAL_FAILURE: u8 = 1;
const CONNECTION_REFUSED: u8 = 5;
const COMMAND_NOT_SUPPORTED: u8 = 7;
const ADDRESS_TYPE_NOT_SUPPORTED: u8 = 8;

/// Serves one SOCKS client: reads its CONNECT request, opens the destination
/// through `connection` and carries the bytes both ways. A client that
/// speaks anything else, or a destination the server cannot reach, gets the
/// matching reply and is closed.
pub(super) async fn serve(mut socket: TcpStream, peer: SocketAddr, connection: &Connection) {
    let _ = socket.set_nodelay(true);
    let Ok(Ok(Some((host, port)))) =
        tokio::time::timeout(HANDSHAKE_TIMEOUT, request(&mut socket)).await
    else {
        return;
    };
    let mut channel = match connection.open_direct_tcpip(&host, port, Some(peer)).await {
        Ok(channel) => channel,
        Err(e) => {
            let code = match e {
                russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed) => {
                    CONNECTION_REFUSED
                }
                _ => GENERAL_FAILURE,
            };
            let _ = reply(&mut socket, code).await;
            return;
        }
    };
    if reply(&mut socket, SUCCEEDED).await.is_err() {
        return;
    }
    let _ = tokio::io::copy_bidirectional(&mut socket, &mut channel).await;
}

/// Negotiates "no authentication" and reads a CONNECT request. `Ok(None)`
/// when the client was turned away (and told why, where SOCKS5 can say it).
async fn request<S>(socket: &mut S) -> std::io::Result<Option<(String, u16)>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let [version, count] = read_array(socket).await?;
    if version != VERSION {
        return Ok(None);
    }
    let mut methods = vec![0; usize::from(count)];
    socket.read_exact(&mut methods).await?;
    if !methods.contains(&NO_AUTH) {
        socket.write_all(&[VERSION, NO_ACCEPTABLE_METHOD]).await?;
        return Ok(None);
    }
    socket.write_all(&[VERSION, NO_AUTH]).await?;

    let [version, command, _reserved, address_type] = read_array(socket).await?;
    if version != VERSION {
        return Ok(None);
    }
    let host = match address_type {
        1 => Ipv4Addr::from(read_array::<_, 4>(socket).await?).to_string(),
        3 => {
            let [len] = read_array(socket).await?;
            let mut name = vec![0; usize::from(len)];
            socket.read_exact(&mut name).await?;
            match String::from_utf8(name) {
                Ok(name) => name,
                Err(_) => {
                    reply(socket, GENERAL_FAILURE).await?;
                    return Ok(None);
                }
            }
        }
        4 => Ipv6Addr::from(read_array::<_, 16>(socket).await?).to_string(),
        _ => {
            reply(socket, ADDRESS_TYPE_NOT_SUPPORTED).await?;
            return Ok(None);
        }
    };
    let port = u16::from_be_bytes(read_array(socket).await?);
    if command != CONNECT {
        reply(socket, COMMAND_NOT_SUPPORTED).await?;
        return Ok(None);
    }
    Ok(Some((host, port)))
}

/// A reply with `code`; the bound address is not shared (all zeros), as
/// OpenSSH does.
async fn reply<S: AsyncWrite + Unpin>(socket: &mut S, code: u8) -> std::io::Result<()> {
    socket
        .write_all(&[VERSION, code, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
}

async fn read_array<S: AsyncRead + Unpin, const N: usize>(
    socket: &mut S,
) -> std::io::Result<[u8; N]> {
    let mut buf = [0; N];
    socket.read_exact(&mut buf).await?;
    Ok(buf)
}
