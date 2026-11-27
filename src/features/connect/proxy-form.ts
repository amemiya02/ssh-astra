import type { HostProxy, ProxyConfig, ProxyKind } from "@/lib/ipc/hosts";

export interface ProxyFormValues {
  mode: "inherit" | "direct" | "proxyCommand" | ProxyKind;
  address: string;
  port: string;
  username: string;
  command?: string;
}

export type ProxyField = "proxyAddress" | "proxyPort" | "proxyUsername" | "proxyCommand";

type ProxyFormResult =
  | { ok: true; proxy: HostProxy }
  | { ok: false; errors: Partial<Record<ProxyField, ProxyField>> };

export function proxyFormFrom(proxy: HostProxy): ProxyFormValues {
  if (proxy.mode === "proxyCommand") return { mode: proxy.mode, address: "", port: "", username: "", command: proxy.config };
  if (proxy.mode !== "override") return { mode: proxy.mode, address: "", port: "", username: "" };
  const { kind, address, port, username } = proxy.config;
  return { mode: kind, address, port: String(port), username: username ?? "" };
}

export const inheritedProxyForm = proxyFormFrom({ mode: "inherit" });

function validAddress(address: string): boolean {
  if (address.includes(":")) {
    const literal = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
    if (!/^[\da-f:.]+$/i.test(literal)) return false;
    try {
      new URL(`http://[${literal}]`);
      return true;
    } catch {
      return false;
    }
  }
  const name = address.replace(/\.$/, "");
  return name.length <= 253 && name.split(".").every((label) => /^[\da-z_-]{1,63}$/i.test(label));
}

function validUsername(username: string, kind: ProxyKind): boolean {
  if (kind === "httpConnect" && username.includes(":")) return false;
  const bytes = new TextEncoder().encode(username).length;
  return bytes <= (kind === "socks5" ? 255 : 4096) && [...username].every((char) => {
    const point = char.charCodeAt(0);
    return point >= 32 && (point < 127 || point > 159);
  });
}

export function parseProxyForm(form: ProxyFormValues = inheritedProxyForm): ProxyFormResult {
  if (form.mode === "direct" || form.mode === "inherit") return { ok: true, proxy: { mode: form.mode } };
  if (form.mode === "proxyCommand") {
    const config = form.command?.trim();
    if (!config || config.includes("\0")) return { ok: false, errors: { proxyCommand: "proxyCommand" } };
    return { ok: true, proxy: { mode: "proxyCommand", config } };
  }
  const address = form.address.trim();
  const portText = form.port.trim();
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  const username = form.username.trim();
  const errors: Partial<Record<ProxyField, ProxyField>> = {};
  if (!validAddress(address)) errors.proxyAddress = "proxyAddress";
  if (!(port >= 1 && port <= 65535)) errors.proxyPort = "proxyPort";
  if (!validUsername(username, form.mode)) errors.proxyUsername = "proxyUsername";
  if (Object.keys(errors).length) return { ok: false, errors };
  const config: ProxyConfig = { kind: form.mode, address, port };
  if (username) config.username = username;
  return { ok: true, proxy: { mode: "override", config } };
}

/** Reads only the public proxy configuration from a saved settings section. */
export function readProxyConfig(raw: unknown): ProxyConfig | undefined {
  if (typeof raw !== "object" || raw === null) return;
  const { kind, address, port, username } = raw as Record<string, unknown>;
  if ((kind !== "socks5" && kind !== "httpConnect") || typeof address !== "string" || typeof port !== "number") return;
  const result = parseProxyForm({
    mode: kind,
    address,
    port: String(port),
    username: typeof username === "string" ? username : "",
  });
  if (result.ok && result.proxy.mode === "override") return result.proxy.config;
}
