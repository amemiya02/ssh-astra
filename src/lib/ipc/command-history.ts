import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { HostId } from "./hosts";

export function listCommandHistory(hostId: HostId): Promise<string[]> {
  return invoke("command_history_list", { hostId });
}

export function clearCommandHistory(hostId: HostId): Promise<void> {
  return invoke("command_history_clear", { hostId });
}

/** The native event carries a Host ID only. Command text stays in the history read. */
export function watchCommandHistory(hostId: HostId, refresh: () => void): () => void {
  if (!isTauri()) return () => undefined;
  let active = true;
  const subscription = listen<HostId>("command-history-changed", ({ payload }) => {
    if (active && payload === hostId) refresh();
  });
  // Subscribe before reading, so a concurrent write always invalidates that snapshot.
  void subscription.then(() => { if (active) refresh(); }, () => { if (active) refresh(); });
  return () => {
    active = false;
    void subscription.then((unlisten) => unlisten(), () => undefined);
  };
}
