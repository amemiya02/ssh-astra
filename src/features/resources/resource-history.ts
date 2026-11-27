import type { ResourceSnapshot, ResourceUsage } from "@/lib/ipc/resources";
import type { TerminalId } from "@/lib/ipc/terminal";
import type { ResourceInterval } from "./resource-settings";

export const resourceHistoryMs = 5 * 60 * 1000;

export interface ResourceTrendSample {
  sampledAt: number;
  cpu: number | null;
  load: number;
  memory: number | null;
  swap: number | null;
  disks: number | null;
  receive: number | null;
  send: number | null;
}

/** The Window's recent readings, scoped to each live Terminal's Connection generation. */
export type ResourceHistories = Map<TerminalId, {
  generation: number;
  interval: ResourceInterval;
  samples: readonly ResourceTrendSample[];
}>;

export function resizeResourceHistory(history: readonly ResourceTrendSample[], now: number, interval: ResourceInterval) {
  // Keep the newest reading in each time bucket when the sampling interval changes.
  const buckets = new Map<number, ResourceTrendSample>();
  for (const point of history) {
    const age = now - point.sampledAt;
    if (age < resourceHistoryMs) buckets.set(Math.floor(age / (interval * 1000)), point);
  }
  return [...buckets.values()];
}

export function recordResourceSample(
  history: readonly ResourceTrendSample[], snapshot: ResourceSnapshot, sampledAt: number, interval: ResourceInterval,
): readonly ResourceTrendSample[] {
  const disks = snapshot.disks.reduce((usage, disk) => ({
    used: usage.used + disk.used, total: usage.total + disk.total,
  }), { used: 0, total: 0 });
  const combinedRate = (key: "receiveRate" | "sendRate") =>
    snapshot.network.reduce<number | null>((rate, link) => {
      const next = link[key];
      return next === null ? rate : (rate ?? 0) + next;
    }, null);
  const point: ResourceTrendSample = {
    sampledAt,
    cpu: snapshot.cpuPercent,
    load: snapshot.load[0],
    memory: usagePercent(snapshot.memory),
    swap: usagePercent(snapshot.swap),
    disks: usagePercent(disks),
    receive: combinedRate("receiveRate"),
    send: combinedRate("sendRate"),
  };
  const capacity = resourceHistoryMs / (interval * 1000);
  return [...history, point].filter((sample) => sampledAt - sample.sampledAt < resourceHistoryMs).slice(-capacity);
}

function usagePercent({ used, total }: ResourceUsage) {
  return total > 0 ? (used / total) * 100 : null;
}
