import type { Host, HostAuth, HostDraft } from "@/lib/ipc/hosts";

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
}

/** The free-text fields, validated here. */
export type HostFormField = Exclude<keyof HostFormValues, "jumpHost" | "authType">;
/** Error codes; the UI maps them to copy under `hosts.errors.*`. */
export type HostFormError = "required" | "port";

export type HostFormResult =
  | { ok: true; draft: HostDraft }
  | { ok: false; errors: Partial<Record<HostFormField, HostFormError>> };

export const emptyHostForm: HostFormValues = {
  name: "",
  address: "",
  port: "22",
  user: "",
  jumpHost: "",
  authType: "password",
  identityFile: "",
};

export function hostFormFrom(host: Host): HostFormValues {
  return {
    name: host.name,
    address: host.address,
    port: String(host.port),
    user: host.user,
    jumpHost: host.jumpHost ?? "",
    authType: host.auth.type,
    identityFile: host.auth.type === "key" ? host.auth.identityFile : "",
  };
}

/** Validates the form. Jump host loops are checked by the backend on save. */
export function parseHostForm(values: HostFormValues): HostFormResult {
  const errors: Partial<Record<HostFormField, HostFormError>> = {};
  const name = values.name.trim();
  const address = values.address.trim();
  const user = values.user.trim();
  const portText = values.port.trim() || "22";
  const identityFile = values.identityFile.trim();

  if (!name) errors.name = "required";
  if (!address) errors.address = "required";
  if (!user) errors.user = "required";
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!(port >= 1 && port <= 65535)) errors.port = "port";
  if (values.authType === "key" && !identityFile) errors.identityFile = "required";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const jumpHost = values.jumpHost || null;
  const auth: HostAuth = values.authType === "key" ? { type: "key", identityFile } : { type: "password" };
  return { ok: true, draft: { name, address, port, user, auth, jumpHost } };
}
