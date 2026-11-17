import { invoke } from "@tauri-apps/api/core";

/** Mirrors `sshastra_core::hosts::HostId`. */
export type HostId = string;

/**
 * Mirrors `sshastra_core::hosts::HostAuth`. Either way a connect tries
 * ssh-agent, then the key file (if any), then password, then
 * keyboard-interactive, as far as the server allows.
 */
export type HostAuth = { type: "password" } | { type: "key"; identityFile: string };

/** A Host's editable fields (`sshastra_core::hosts::HostDraft`). */
export interface HostDraft {
  name: string;
  address: string;
  port: number;
  user: string;
  auth: HostAuth;
}

/** A saved Host (`sshastra_core::hosts::Host`). */
export interface Host extends HostDraft {
  id: HostId;
}

export function listHosts(): Promise<Host[]> {
  return invoke<Host[]>("hosts_list");
}

/** Adds a Host, or replaces the Host with `id`. */
export function saveHost(draft: HostDraft, id?: HostId): Promise<Host> {
  return invoke<Host>("host_save", { id: id ?? null, draft });
}

export function deleteHost(id: HostId): Promise<void> {
  return invoke("host_delete", { id });
}
