import type { Host } from "@/lib/ipc/hosts";
import { tabPanes, type Tab } from "./tabs";

export type TabGroup = { type: "host"; host: Host; tabs: Tab[] } | { type: "tab"; tab: Tab };

/** Group in the order each Host first appears, without changing the order of its tabs. */
export function groupTabsByHost(tabs: readonly Tab[]): TabGroup[] {
  const hosts = new Map<string, { type: "host"; host: Host; tabs: Tab[] }>();
  const groups: TabGroup[] = [];
  for (const tab of tabs) {
    const panes = tabPanes(tab);
    const first = panes[0];
    if (!first || !("host" in first) || !panes.every((pane) => "host" in pane && pane.host.id === first.host.id)) {
      groups.push({ type: "tab", tab });
      continue;
    }
    const previous = hosts.get(first.host.id);
    if (previous) previous.tabs.push(tab);
    else {
      const group = { type: "host" as const, host: first.host, tabs: [tab] };
      hosts.set(first.host.id, group);
      groups.push(group);
    }
  }
  return groups.map((group) => group.type === "host" && group.tabs.length === 1
    ? { type: "tab", tab: group.tabs[0]! }
    : group);
}
