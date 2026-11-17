import type { TFunction } from "i18next";
import type { ForwardEvent, PortForward } from "@/lib/ipc/forwards";
import type { Host, HostId } from "@/lib/ipc/hosts";
import { describeForward } from "./forwardForm";
import { forwardKind } from "./kinds";

/** A running rule as the status bar lists it: `localhost:15432 → db:5432`, `SOCKS localhost:1080`. */
export function forwardStatusText(rule: PortForward, t: TFunction): string {
  const { from, to } = describeForward(rule);
  return t(forwardKind(rule.type).status, { from, to: to ?? "" });
}

/** A running Port forward with the Host and saved rule it belongs to. */
export interface RunningRule {
  host: Host;
  rule: PortForward;
}

/** Running forwards whose Host and rule are still saved, in the order given. */
export function runningRules(running: ForwardEvent[], hosts: Host[]): RunningRule[] {
  return running.flatMap((event) => {
    const host = hosts.find((h) => h.id === event.hostId);
    const rule = host?.forwards.find((f) => f.id === event.forwardId);
    return host && rule ? [{ host, rule }] : [];
  });
}

/**
 * The Hosts with a live Connection, as the status bar lists them: those with a connected
 * Terminal first, then those held by "Connect only" (`held`), then those held open only by
 * running Port forwards; each once.
 */
export function activeConnections(
  terminalHosts: Host[],
  running: ForwardEvent[],
  hosts: Host[],
  held: HostId[] = [],
): Host[] {
  const active = new Map(terminalHosts.map((h) => [h.id, h]));
  for (const id of held) {
    const host = hosts.find((h) => h.id === id);
    if (host && !active.has(id)) active.set(id, host);
  }
  for (const { host } of runningRules(running, hosts)) {
    if (!active.has(host.id)) active.set(host.id, host);
  }
  return [...active.values()];
}
