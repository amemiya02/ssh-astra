import type { TabsState } from "@/features/workspace/tabs";
import type { Host, HostId } from "@/lib/ipc/hosts";

/** A Host's Connection as a Host row or card shows it; a Host with none has no entry. */
export type HostConnection = "connecting" | "connected";

/**
 * The Connection state of every Host that has one, for Host rows and cards: `connected` for the
 * Hosts with a live Connection (`connected`: a Terminal, "Connect only" or a running Port forward),
 * `connecting` for Hosts a Terminal is opening or reconnecting to, or "Connect only" is still
 * reaching (`connecting`). A Terminal retrying a dropped Connection wins over the rest.
 */
export function hostConnections(
  connected: readonly Host[],
  tabs: TabsState,
  connecting: readonly HostId[],
): ReadonlyMap<HostId, HostConnection> {
  const states = new Map<HostId, HostConnection>();
  for (const host of connected) states.set(host.id, "connected");
  for (const id of connecting) if (!states.has(id)) states.set(id, "connecting");
  for (const pane of tabs.tabs.flatMap((tab) => tab.panes)) {
    if (pane.kind !== "remote-terminal" && pane.kind !== "sftp") continue;
    if (pane.reconnecting || (pane.status === "connecting" && !states.has(pane.host.id))) {
      states.set(pane.host.id, "connecting");
    }
  }
  return states;
}
