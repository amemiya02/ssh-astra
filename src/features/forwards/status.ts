import type { ForwardEvent, PortForward } from "@/lib/ipc/forwards";
import type { Host } from "@/lib/ipc/hosts";

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
 * Terminal first, then those held open only by running Port forwards; each once.
 */
export function activeConnections(terminalHosts: Host[], running: ForwardEvent[], hosts: Host[]): Host[] {
  const active = new Map(terminalHosts.map((h) => [h.id, h]));
  for (const { host } of runningRules(running, hosts)) {
    if (!active.has(host.id)) active.set(host.id, host);
  }
  return [...active.values()];
}
