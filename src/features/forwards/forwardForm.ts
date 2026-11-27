import type { ForwardDraft, ForwardType, PortForward } from "@/lib/ipc/forwards";
import { forwardKind } from "./kinds";

/**
 * The Port forward form's raw input values. `targetHost`/`targetPort` are where a connection
 * goes: as the server sees it for a local forward, from this machine for a remote one. Proxy
 * clients choose their own targets.
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

/** The address a blank bind address stands for. */
export function defaultBindAddress(type: ForwardType): string {
  return forwardKind(type).defaultBindAddress;
}

export function emptyForwardForm(type: ForwardType): ForwardFormValues {
  return { type, label: "", bindAddress: "", bindPort: "", targetHost: "", targetPort: "", autoStart: false };
}

export function forwardFormFrom(rule: PortForward): ForwardFormValues {
  const target = forwardKind(rule.type).target(rule);
  return {
    type: rule.type,
    label: rule.label,
    bindAddress: rule.bindAddress === defaultBindAddress(rule.type) ? "" : rule.bindAddress,
    bindPort: String(rule.bindPort),
    targetHost: target?.host ?? "",
    targetPort: target ? String(target.port) : "",
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
  const kind = forwardKind(values.type);
  const target = { host: values.targetHost.trim(), port: parsePort(values.targetPort) ?? 0 };
  if (kind.hasTarget) {
    if (!target.host) errors.targetHost = "required";
    if (target.port === 0) errors.targetPort = "port";
  }
  if (bindPort === null || Object.keys(errors).length > 0) return { ok: false, errors };
  const draft: ForwardDraft = {
    label: values.label.trim(),
    autoStart: values.autoStart,
    bindAddress: values.bindAddress.trim() || kind.defaultBindAddress,
    bindPort,
    ...kind.fields(target),
  };
  return { ok: true, draft };
}

const hostPort = (host: string, port: number) => (host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`);

/**
 * The two ends of a rule, as `host:port` text: where it listens (on the server for a remote
 * forward) and where connections go (`null` for proxies, whose clients choose).
 */
export function describeForward(rule: ForwardDraft): { from: string; to: string | null } {
  const bind = rule.bindAddress === "127.0.0.1" ? "localhost" : rule.bindAddress;
  const target = forwardKind(rule.type).target(rule);
  return { from: hostPort(bind, rule.bindPort), to: target && hostPort(target.host, target.port) };
}
