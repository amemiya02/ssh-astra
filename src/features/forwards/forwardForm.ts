import type { ForwardDraft, ForwardType, PortForward } from "@/lib/ipc/forwards";

/**
 * The Port forward form's raw input values. `targetHost`/`targetPort` are where a connection
 * goes: as the server sees it for a local forward, from this machine for a remote one; a dynamic
 * forward has none.
 */
export interface ForwardFormValues {
  type: ForwardType;
  label: string;
  /** Blank listens on loopback only (this machine's, or the server's for a remote forward). */
  bindAddress: string;
  bindPort: string;
  targetHost: string;
  targetPort: string;
  autoStart: boolean;
}

export type ForwardFormField = "bindPort" | "targetHost" | "targetPort";
/** Error codes; the UI maps them to copy under `forwards.errors.*`. */
export type ForwardFormError = "required" | "port";

export type ForwardFormResult =
  | { ok: true; draft: ForwardDraft }
  | { ok: false; errors: Partial<Record<ForwardFormField, ForwardFormError>> };

const loopback = "127.0.0.1";
/** Where the server listens for a remote forward by default (`sshastra_core::forward::REMOTE_LOOPBACK`). */
const remoteLoopback = "localhost";

/** The address a blank bind address stands for. */
export function defaultBindAddress(type: ForwardType): string {
  return type === "remote" ? remoteLoopback : loopback;
}

export function emptyForwardForm(type: ForwardType): ForwardFormValues {
  return { type, label: "", bindAddress: "", bindPort: "", targetHost: "", targetPort: "", autoStart: false };
}

export function forwardFormFrom(rule: PortForward): ForwardFormValues {
  const target =
    rule.type === "local"
      ? { targetHost: rule.remoteHost, targetPort: String(rule.remotePort) }
      : rule.type === "remote"
        ? { targetHost: rule.localHost, targetPort: String(rule.localPort) }
        : { targetHost: "", targetPort: "" };
  return {
    type: rule.type,
    label: rule.label,
    bindAddress: rule.bindAddress === defaultBindAddress(rule.type) ? "" : rule.bindAddress,
    bindPort: String(rule.bindPort),
    ...target,
    autoStart: rule.autoStart,
  };
}

function parsePort(text: string): number | null {
  const trimmed = text.trim();
  const port = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  return port >= 1 && port <= 65535 ? port : null;
}

export function parseForwardForm(values: ForwardFormValues): ForwardFormResult {
  const errors: Partial<Record<ForwardFormField, ForwardFormError>> = {};
  const bindPort = parsePort(values.bindPort);
  if (bindPort === null) errors.bindPort = "port";
  const common = {
    label: values.label.trim(),
    autoStart: values.autoStart,
    bindAddress: values.bindAddress.trim() || defaultBindAddress(values.type),
  };
  if (values.type === "dynamic") {
    if (bindPort === null) return { ok: false, errors };
    return { ok: true, draft: { ...common, type: "dynamic", bindPort } };
  }
  const targetHost = values.targetHost.trim();
  const targetPort = parsePort(values.targetPort);
  if (!targetHost) errors.targetHost = "required";
  if (targetPort === null) errors.targetPort = "port";
  if (bindPort === null || targetPort === null || !targetHost) return { ok: false, errors };
  const draft: ForwardDraft =
    values.type === "local"
      ? { ...common, type: "local", bindPort, remoteHost: targetHost, remotePort: targetPort }
      : { ...common, type: "remote", bindPort, localHost: targetHost, localPort: targetPort };
  return { ok: true, draft };
}

const hostPort = (host: string, port: number) => (host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`);

/**
 * The two ends of a rule, as `host:port` text: where it listens (on the server for a remote
 * forward) and where connections go (`null` for a dynamic forward, whose clients choose).
 */
export function describeForward(rule: ForwardDraft): { from: string; to: string | null } {
  const bind = rule.bindAddress === loopback ? "localhost" : rule.bindAddress;
  const from = hostPort(bind, rule.bindPort);
  switch (rule.type) {
    case "local":
      return { from, to: hostPort(rule.remoteHost, rule.remotePort) };
    case "remote":
      return { from, to: hostPort(rule.localHost, rule.localPort) };
    case "dynamic":
      return { from, to: null };
  }
}
