import { parseProxyForm, proxyFormFrom, type ProxyField, type ProxyFormValues } from "@/features/connect/proxy-form";
import type { Host, HostAuth, HostDraft, TerminalBackspace, TerminalCharset } from "@/lib/ipc/hosts";
import { isTerminalColorScheme, type ImportedTerminalScheme, type TerminalColorScheme } from "@/theme/terminal-themes";

/** The Host form's raw input values. */
export interface HostFormValues {
  name: string;
  address: string;
  port: string;
  user: string;
  /** The Jump host's id, or "" to connect directly. */
  jumpHost: string;
  authType: HostAuth["type"];
  /** Private key path; used when `authType` is `"key"`. */
  identityFile: string;
  identitiesOnly: boolean;
  forwardAgent: boolean;
  proxy?: ProxyFormValues;
  /** Blank follows the global keepalive interval. */
  keepaliveSeconds?: string;
  /** Blank leaves the shell at its first prompt. */
  postLoginCommand?: string;
  terminalCharset: TerminalCharset;
  terminalBackspace: TerminalBackspace;
  /** The Host's own Terminal colour scheme; absent follows the global one. */
  terminalScheme?: TerminalColorScheme;
  /** Where the File panel opens first; blank is the home directory. */
  defaultDirectory?: string;
}

/** The free-text fields, validated here. */
type HostInputField = Exclude<
  keyof HostFormValues,
  "jumpHost" | "authType" | "identitiesOnly" | "forwardAgent" | "terminalScheme" | "defaultDirectory" |
  "postLoginCommand" | "terminalCharset" | "terminalBackspace" | "proxy"
>;
/** Error codes; the UI maps them to copy under `hosts.errors.*`. */
export type HostFormError = "required" | "port" | "keepaliveSeconds";
export type HostFormField = HostInputField | ProxyField;
type HostFormErrors = Partial<Record<HostInputField, HostFormError> & Record<ProxyField, ProxyField>>;

export type HostFormResult =
  | { ok: true; draft: HostDraft }
  | { ok: false; errors: HostFormErrors };

export const emptyHostForm: HostFormValues = {
  name: "",
  address: "",
  port: "22",
  user: "",
  jumpHost: "",
  authType: "auto",
  identityFile: "",
  identitiesOnly: false,
  forwardAgent: false,
  terminalCharset: "utf8",
  terminalBackspace: "del",
};

export function hostFormFrom(host: Host, importedSchemes: readonly ImportedTerminalScheme[] = []): HostFormValues {
  const form: HostFormValues = {
    name: host.name,
    address: host.address,
    port: String(host.port),
    user: host.user,
    jumpHost: host.jumpHost ?? "",
    authType: host.auth.type,
    identityFile: host.auth.type === "key" ? host.auth.identityFile : "",
    identitiesOnly: host.identitiesOnly ?? false,
    forwardAgent: host.forwardAgent ?? false,
    terminalCharset: host.terminalCharset ?? emptyHostForm.terminalCharset,
    terminalBackspace: host.terminalBackspace ?? emptyHostForm.terminalBackspace,
  };
  if (host.proxy) form.proxy = proxyFormFrom(host.proxy);
  if (isTerminalColorScheme(host.terminalScheme, importedSchemes)) form.terminalScheme = host.terminalScheme;
  if (host.defaultDirectory) form.defaultDirectory = host.defaultDirectory;
  if (host.keepaliveSeconds !== undefined) form.keepaliveSeconds = String(host.keepaliveSeconds);
  if (host.postLoginCommand) form.postLoginCommand = host.postLoginCommand;
  return form;
}

/** Validates the form. The backend checks Jump host loops. */
export function parseHostForm(values: HostFormValues, purpose: "save" | "test" = "save"): HostFormResult {
  const errors: HostFormErrors = {};
  const name = values.name.trim();
  const address = values.address.trim();
  const user = values.user.trim();
  const portText = values.port.trim() || "22";
  const identityFile = values.identityFile.trim();
  const keepaliveText = values.keepaliveSeconds?.trim() ?? "";
  const keepaliveSeconds = Number(keepaliveText);

  if (purpose === "save" && !name) errors.name = "required";
  if (!address) errors.address = "required";
  if (!user) errors.user = "required";
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!(port >= 1 && port <= 65535)) errors.port = "port";
  if (values.authType === "key" && !identityFile) errors.identityFile = "required";
  if (keepaliveText && (!/^\d+$/.test(keepaliveText) || keepaliveSeconds > 0xffff_ffff)) {
    errors.keepaliveSeconds = "keepaliveSeconds";
  }

  const proxy = parseProxyForm(purpose === "test" && values.jumpHost ? undefined : values.proxy);
  if (!proxy.ok) return { ok: false, errors: { ...errors, ...proxy.errors } };
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const jumpHost = values.jumpHost || null;
  const auth: HostAuth = values.authType === "key" ? { type: "key", identityFile } : { type: values.authType };
  const draft: HostDraft = {
    name: name || address, address, port, user, auth, jumpHost,
    identitiesOnly: values.identitiesOnly,
    forwardAgent: values.forwardAgent,
  };
  if (proxy.proxy.mode !== "inherit") draft.proxy = proxy.proxy;
  if (values.terminalScheme) draft.terminalScheme = values.terminalScheme;
  if (keepaliveText) draft.keepaliveSeconds = keepaliveSeconds;
  if (values.postLoginCommand?.trim()) draft.postLoginCommand = values.postLoginCommand;
  if (values.terminalCharset !== emptyHostForm.terminalCharset) draft.terminalCharset = values.terminalCharset;
  if (values.terminalBackspace !== emptyHostForm.terminalBackspace) draft.terminalBackspace = values.terminalBackspace;
  const defaultDirectory = values.defaultDirectory?.trim();
  if (defaultDirectory) draft.defaultDirectory = defaultDirectory;
  return { ok: true, draft };
}
