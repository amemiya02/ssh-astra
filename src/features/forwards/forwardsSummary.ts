import type { ForwardEvent } from "@/lib/ipc/forwards";
import type { Host, HostId } from "@/lib/ipc/hosts";

/** A Host that has Port forward rules, with how many of them are running. */
export interface HostForwards {
  host: Host;
  running: number;
  total: number;
}

/** The Hosts with at least one saved rule, in list order, each with its running/total count. */
export function hostsWithForwards(hosts: Host[], running: ForwardEvent[]): HostForwards[] {
  const runningByHost = new Map<HostId, Set<string>>();
  for (const event of running) {
    const ids = runningByHost.get(event.hostId) ?? new Set<string>();
    ids.add(event.forwardId);
    runningByHost.set(event.hostId, ids);
  }
  return hosts
    .filter((host) => host.forwards.length > 0)
    .map((host) => {
      const live = runningByHost.get(host.id);
      return { host, total: host.forwards.length, running: host.forwards.filter((rule) => live?.has(rule.id)).length };
    });
}
