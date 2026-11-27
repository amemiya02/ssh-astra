import { useEffect, useRef } from "react";
import type { HostConnection } from "@/features/connect/hostConnection";
import type { HostId } from "@/lib/ipc/hosts";
import { defineSection, getSetting, setSetting } from "@/lib/storage";

const keep = 20;

interface HostVisit {
  openedAt?: number;
  connectedAt?: number;
}

export type HostHistory = Readonly<Partial<Record<HostId, HostVisit>>>;

function parseTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** When a Host was opened and when it established a Connection, in milliseconds. */
export const recentHostsSetting = defineSection<HostHistory>("recentHosts", {}, (raw) => {
  if (Array.isArray(raw)) {
    const ids = [...new Set(raw.filter((id): id is HostId => typeof id === "string"))].slice(0, keep);
    // Older settings only stored order. Negative ranks preserve it until real timestamps exist.
    return Object.fromEntries(ids.map((id, i) => [id, { openedAt: -i - 1, connectedAt: -i - 1 }]));
  }
  if (typeof raw !== "object" || raw === null) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([id, value]): [HostId, HostVisit][] => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const visit = value as Record<string, unknown>;
    const openedAt = parseTime(visit.openedAt);
    const connectedAt = parseTime(visit.connectedAt);
    return openedAt === undefined && connectedAt === undefined ? [] : [[id, { openedAt, connectedAt }]];
  }));
});

/** Ids of the Hosts opened lately, most recent first, for Home and the palette. */
export function recentHostIds(history: HostHistory): HostId[] {
  return Object.entries(history)
    .flatMap(([id, visit]): [HostId, number][] => visit?.openedAt === undefined ? [] : [[id, visit.openedAt]])
    .sort(([, a], [, b]) => b - a)
    .slice(0, keep)
    .map(([id]) => id);
}

export function noteOpened(history: HostHistory, id: HostId, time: number): HostHistory {
  // Preserve the order of opening Hosts even if they share a millisecond or the clock steps back.
  const latest = Object.values(history).reduce((max, visit) => Math.max(max, visit?.openedAt ?? -Infinity), -Infinity);
  return { ...history, [id]: { ...history[id], openedAt: Math.max(time, latest + 1) } };
}

/** Records that a Terminal or SFTP workspace was opened on the Host. */
export function rememberHostOpened(id: HostId): void {
  setSetting(recentHostsSetting, noteOpened(getSetting(recentHostsSetting), id, Date.now()));
}

/** Records each Host that reached connected since the last snapshot. */
export function noteConnections(
  history: HostHistory,
  previous: ReadonlyMap<HostId, HostConnection>,
  current: ReadonlyMap<HostId, HostConnection>,
  time: number,
): HostHistory {
  const updates: [HostId, HostVisit][] = [];
  for (const [id, status] of current) {
    if (status === "connected" && previous.get(id) !== "connected") {
      updates.push([id, { ...history[id], connectedAt: time }]);
    }
  }
  return updates.length > 0 ? { ...history, ...Object.fromEntries(updates) } : history;
}

export function useRecordHostConnections(connections: ReadonlyMap<HostId, HostConnection>): void {
  const previous = useRef<ReadonlyMap<HostId, HostConnection>>(new Map());
  useEffect(() => {
    const history = getSetting(recentHostsSetting);
    const next = noteConnections(history, previous.current, connections, Date.now());
    previous.current = connections;
    if (next !== history) setSetting(recentHostsSetting, next);
  }, [connections]);
}
