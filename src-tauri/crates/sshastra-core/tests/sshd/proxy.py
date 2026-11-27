"""Synthetic CONNECT and SOCKS5 proxy for the isolated proxy-target fixture."""

import asyncio
import base64
import ipaddress
import struct
from contextlib import suppress

TARGET = ("proxy-target.test", 22)
IPV6 = ipaddress.IPv6Address("2001:db8::7")
USERNAME = b"proxy-fixture"
PASSWORD = b"outbound-proxy-test-secret"


async def sized_bytes(reader):
    size = (await reader.readexactly(1))[0]
    return await reader.readexactly(size)


async def socks5(reader, writer, auth):
    version, count = await reader.readexactly(2)
    methods = await reader.readexactly(count)
    method = 2 if auth else 0
    if version != 5 or method not in methods:
        writer.write(b"\x05\xff")
        return None
    writer.write(bytes([5, method]))
    await writer.drain()
    if auth:
        auth_version = await reader.readexactly(1)
        username = await sized_bytes(reader)
        password = await sized_bytes(reader)
        allowed = auth_version == b"\x01" and (username, password) == (USERNAME, PASSWORD)
        writer.write(bytes([1, int(not allowed)]))
        await writer.drain()
        if not allowed:
            return None
    version, command, reserved, family = await reader.readexactly(4)
    if family == 3:
        host = (await sized_bytes(reader)).decode("ascii")
    elif family == 4:
        host = str(ipaddress.IPv6Address(await reader.readexactly(16)))
    else:
        host = ""
    port = struct.unpack("!H", await reader.readexactly(2))[0]
    if (version, command, reserved) != (5, 1, 0) or port != TARGET[1] or host not in {TARGET[0], str(IPV6)}:
        writer.write(b"\x05\x02\x00\x01" + bytes(6))
        return None
    return b"\x05\x00\x00\x01" + bytes(6)


async def http_connect(reader, writer, auth):
    request = await reader.readuntil(b"\r\n\r\n")
    line, *headers = request.split(b"\r\n")
    authorization = b"Proxy-Authorization: Basic " + base64.b64encode(USERNAME + b":" + PASSWORD)
    if auth and authorization not in headers:
        writer.write(b"HTTP/1.1 407 Proxy Authentication Required\r\n"
                     b'Proxy-Authenticate: Basic realm="sshastra tests"\r\n\r\n')
        return None
    if line == b"CONNECT oversized.test:22 HTTP/1.1":
        writer.write(b"HTTP/1.1 200 OK\r\nX-Oversized: " + b"x" * 16384 + b"\r\n\r\n")
        return None
    if line == b"CONNECT invalid.test:22 HTTP/1.1":
        writer.write(b"HTTP/1.1 2000 Bad status\r\n\r\n")
        return None
    targets = {f"CONNECT {TARGET[0]}:22 HTTP/1.1".encode(), f"CONNECT [{IPV6}]:22 HTTP/1.1".encode()}
    if line not in targets:
        writer.write(b"HTTP/1.1 403 Forbidden\r\n\r\n")
        return None
    return b"HTTP/1.1 200 Connection Established\r\n\r\n"


async def relay(reader, writer):
    while data := await reader.read(8192):
        writer.write(data)
        await writer.drain()
    writer.write_eof()


async def handle(reader, writer, negotiate, auth):
    upstream = None
    try:
        async with asyncio.timeout(5):
            success = await negotiate(reader, writer, auth)
            if not success:
                await writer.drain()
                return
            upstream, target = await asyncio.open_connection(*TARGET)
            banner = await upstream.readuntil(b"\n")
            # Coalesce the SSH banner and the proxy response in the same write.
            writer.write(success + banner)
            await writer.drain()
        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(relay(reader, target))
            tasks.create_task(relay(upstream, writer))
    except (OSError, EOFError, UnicodeError, asyncio.LimitOverrunError):
        pass
    except ExceptionGroup as errors:
        # Reset during the test's normal teardown is an expected relay exit.
        if errors.subgroup(lambda error: not isinstance(error, (BaseExceptionGroup, OSError))):
            raise
    finally:
        writer.close()
        with suppress(OSError):
            await writer.wait_closed()
        if upstream is not None:
            target.close()
            with suppress(OSError):
                await target.wait_closed()


async def main():
    listeners = [(1080, socks5, False), (1081, socks5, True),
                 (3128, http_connect, False), (3129, http_connect, True)]
    servers = []
    for port, negotiate, auth in listeners:
        def accept(reader, writer, negotiate=negotiate, auth=auth):
            return handle(reader, writer, negotiate, auth)

        servers.append(await asyncio.start_server(accept, "0.0.0.0", port))
    await asyncio.gather(*(server.serve_forever() for server in servers))


asyncio.run(main())
