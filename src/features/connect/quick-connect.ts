import type { Host, QuickConnectTarget } from "@/lib/ipc/hosts";

/** Parse an SSH destination. An IPv6 address with a port must be bracketed. */
export function parseQuickConnect(input: string): QuickConnectTarget | undefined {
  const [first, second, extra] = input.trim().split("@");
  if (extra !== undefined) return;
  const user = second === undefined ? undefined : first;
  if (user !== undefined && !/^[\p{L}\p{N}_.\\-]+$/u.test(user)) return;
  const endpoint = second ?? first;
  if (!endpoint) return;

  let address: string | undefined;
  let portText: string | undefined;
  if (endpoint.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(endpoint);
    if (!match || !isIpv6(match[1]!)) return;
    [, address, portText] = match;
  } else if (endpoint.indexOf(":") !== endpoint.lastIndexOf(":")) {
    if (!isIpv6(endpoint)) return;
    address = endpoint;
  } else {
    [address, portText] = endpoint.split(":");
    if (!address || !isHostname(address)) return;
  }

  if (portText !== undefined && !/^[0-9]+$/.test(portText)) return;
  const port = portText === undefined ? 22 : Number(portText);
  if (!address || port < 1 || port > 65535) return;
  return { address, port, ...(user === undefined ? {} : { user }) };
}

function isHostname(address: string): boolean {
  const hostname = address.endsWith(".") ? address.slice(0, -1) : address;
  if (hostname.length > 253) return false;
  const labels = hostname.split(".");
  if (labels.length > 1 && labels.every((part) => /^[0-9]+$/.test(part))) {
    return labels.length === 4 && labels.every((part) => part.length <= 3 && Number(part) <= 255);
  }
  return labels.every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part));
}

function isIpv6(address: string): boolean {
  if (!address.includes(":") || !/^[0-9a-f:.]+$/i.test(address)) return false;
  try {
    return new URL("http://[" + address + "]/").hostname.startsWith("[");
  } catch {
    return false;
  }
}

export function exactHostMatch(hosts: readonly Host[], input: string): Host | undefined {
  const query = input.trim().toLowerCase();
  return query ? hosts.find((host) => host.name.toLowerCase() === query) : undefined;
}

export function quickConnectLabel({ user, address, port }: QuickConnectTarget): string {
  const endpoint = address.includes(":") ? "[" + address + "]" : address;
  return (user ? user + "@" : "") + endpoint + (port === 22 ? "" : ":" + port);
}
