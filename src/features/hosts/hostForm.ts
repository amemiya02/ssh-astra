import type { Host, HostDraft } from "@/lib/ipc/hosts";
import { isTerminalColorScheme, type TerminalColorScheme } from "@/theme/terminal-themes";

/** The Host form's raw input values. */
export interface HostFormValues {
  name: string;
  address: string;
  port: string;
  user: string;
  /** The Host's own Terminal colour scheme; absent follows the global one. */
  terminalScheme?: TerminalColorScheme;
}

/** The text fields, validated by `parseHostForm`. */
export type HostFormField = Exclude<keyof HostFormValues, "terminalScheme">;
/** Error codes; the UI maps them to copy under `hosts.errors.*`. */
export type HostFormError = "required" | "port";

export type HostFormResult =
  | { ok: true; draft: HostDraft }
  | { ok: false; errors: Partial<Record<HostFormField, HostFormError>> };

export const emptyHostForm: HostFormValues = { name: "", address: "", port: "22", user: "" };

export function hostFormFrom(host: Host): HostFormValues {
  const form: HostFormValues = { name: host.name, address: host.address, port: String(host.port), user: host.user };
  if (isTerminalColorScheme(host.terminalScheme)) form.terminalScheme = host.terminalScheme;
  return form;
}

export function parseHostForm(values: HostFormValues): HostFormResult {
  const errors: Partial<Record<HostFormField, HostFormError>> = {};
  const name = values.name.trim();
  const address = values.address.trim();
  const user = values.user.trim();
  const portText = values.port.trim() || "22";

  if (!name) errors.name = "required";
  if (!address) errors.address = "required";
  if (!user) errors.user = "required";
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!(port >= 1 && port <= 65535)) errors.port = "port";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const draft: HostDraft = { name, address, port, user, auth: { type: "password" } };
  if (values.terminalScheme) draft.terminalScheme = values.terminalScheme;
  return { ok: true, draft };
}
