import type { HostTree } from "@/lib/ipc/hosts";
import { defineSection } from "@/lib/storage";
import type { HostHistory } from "./host-history";

export const hostSortOrders = ["manual", "name", "address", "recent"] as const;
export type HostSort = (typeof hostSortOrders)[number];

export const hostSortSetting = defineSection<HostSort>("hostSort", "manual", (raw) =>
  hostSortOrders.find((order) => order === raw) ?? "manual",
);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Orders Hosts for display. Group order and the saved positions stay intact. */
export function sortHostTree(tree: HostTree, order: HostSort, history: HostHistory = {}): HostTree {
  if (order === "manual") return tree;
  const hosts = [...tree.hosts].sort((a, b) => {
    if (order !== "recent") return collator.compare(a[order], b[order]);
    const aTime = history[a.id]?.connectedAt ?? -Infinity;
    const bTime = history[b.id]?.connectedAt ?? -Infinity;
    return aTime === bTime ? 0 : bTime - aTime;
  });
  return { ...tree, hosts };
}
