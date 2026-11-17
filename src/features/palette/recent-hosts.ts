import type { HostId } from "@/lib/ipc/hosts";
import { defineSection, getSetting, setSetting } from "@/lib/storage";

const keep = 20;

/** Ids of the Hosts the user opened lately, most recent first; the palette lists these first. */
export const recentHostsSetting = defineSection<HostId[]>("recentHosts", [], (raw) =>
  Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === "string"))].slice(0, keep) : [],
);

/** `recent` after opening `id`: it moves to the front, and only the latest few are kept. */
export function noteOpened(recent: HostId[], id: HostId): HostId[] {
  return [id, ...recent.filter((other) => other !== id)].slice(0, keep);
}

/** Records that a Terminal was opened on the Host `id`. */
export function rememberHostOpened(id: HostId): void {
  setSetting(recentHostsSetting, noteOpened(getSetting(recentHostsSetting), id));
}
