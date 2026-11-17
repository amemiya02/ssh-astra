import type { ForwardDraft, PortForward } from "@/lib/ipc/forwards";

/** The Port forward form's raw input values (a local forward). */
export interface ForwardFormValues {
  label: string;
  /** Blank listens on 127.0.0.1 only. */
  bindAddress: string;
  bindPort: string;
  remoteHost: string;
  remotePort: string;
}

export type ForwardFormField = "bindPort" | "remoteHost" | "remotePort";
/** Error codes; the UI maps them to copy under `forwards.errors.*`. */
export type ForwardFormError = "required" | "port";

export type ForwardFormResult =
  | { ok: true; draft: ForwardDraft }
  | { ok: false; errors: Partial<Record<ForwardFormField, ForwardFormError>> };

const loopback = "127.0.0.1";

export const emptyForwardForm: ForwardFormValues = {
  label: "",
  bindAddress: "",
  bindPort: "",
  remoteHost: "",
  remotePort: "",
};

export function forwardFormFrom(rule: PortForward): ForwardFormValues {
  return {
    label: rule.label,
    bindAddress: rule.bindAddress === loopback ? "" : rule.bindAddress,
    bindPort: String(rule.bindPort),
    remoteHost: rule.remoteHost,
    remotePort: String(rule.remotePort),
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
  const remotePort = parsePort(values.remotePort);
  const remoteHost = values.remoteHost.trim();
  if (bindPort === null) errors.bindPort = "port";
  if (!remoteHost) errors.remoteHost = "required";
  if (remotePort === null) errors.remotePort = "port";
  if (bindPort === null || remotePort === null || !remoteHost) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      label: values.label.trim(),
      type: "local",
      bindAddress: values.bindAddress.trim() || loopback,
      bindPort,
      remoteHost,
      remotePort,
    },
  };
}

const hostPort = (host: string, port: number) => (host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`);

/** The two ends of a rule, as `host:port` text. */
export function describeForward(rule: ForwardDraft): { from: string; to: string } {
  const bind = rule.bindAddress === loopback ? "localhost" : rule.bindAddress;
  return { from: hostPort(bind, rule.bindPort), to: hostPort(rule.remoteHost, rule.remotePort) };
}
