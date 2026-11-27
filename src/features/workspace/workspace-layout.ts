import { defineSection } from "@/lib/storage";
import type { Host } from "@/lib/ipc/hosts";
import { ansiHues } from "@/theme/monogram-ink";
import { layoutPanes, maxPanesPerTab, startupTabs, type Pane, type PaneLayout, type Tab, type TabsState } from "./tabs";
import type { RestoreTabs } from "./workspace-prefs";

type HostedPaneKind = Extract<Pane, { host: unknown }>["kind"];

export type SavedPane = { id: string } & (
  | { kind: "home" | "settings" }
  | { kind: "local-terminal"; cwd?: string }
  | { kind: HostedPaneKind; hostId: string }
);

export interface WorkspaceLayout {
  tabs: (Omit<Tab, "layout" | "paneMaximized"> & { layout: PaneLayout<SavedPane> })[];
  activeId: string | null;
}

/** Persists layout, pane identities, and Local terminal directories. */
export function serializeWorkspaceLayout(state: TabsState): WorkspaceLayout {
  return {
    activeId: state.activeId,
    tabs: state.tabs.map(({ id, activePaneId, layout, customTitle, color, locked }) => ({
      id, activePaneId, layout: serializeLayout(layout), customTitle, color, locked,
    })),
  };
}

function serializeLayout(layout: PaneLayout): PaneLayout<SavedPane> {
  if (layout.type === "split") {
    return { ...layout, children: layout.children.map(({ ratio, layout }) => ({ ratio, layout: serializeLayout(layout) })) };
  }
  const { pane } = layout;
  const { id } = pane;
  if (pane.kind === "local-terminal" && pane.cwd !== undefined) {
    return { type: "pane", pane: { id, kind: pane.kind, cwd: pane.cwd } };
  }
  return { type: "pane", pane: "host" in pane ? { id, kind: pane.kind, hostId: pane.host.id } : { id, kind: pane.kind } };
}

export const workspaceLayoutSetting = defineSection<WorkspaceLayout>("workspace", { tabs: [], activeId: null }, (raw) => {
  if (!isRecord(raw) || !Array.isArray(raw.tabs)) return { tabs: [], activeId: null };

  const tabs: WorkspaceLayout["tabs"] = [];
  const tabIds = new Set<string>();
  const paneIds = new Set<string>();
  for (const tab of raw.tabs) {
    if (!isRecord(tab) || !isId(tab.id) || tabIds.has(tab.id)) continue;
    let remaining = maxPanesPerTab;
    const readPane = (raw: unknown) => {
      const pane = parsePane(raw);
      if (!pane || remaining === 0 || paneIds.has(pane.id)) return undefined;
      remaining--;
      paneIds.add(pane.id);
      return { type: "pane" as const, pane };
    };
    const layout = parseLayout(tab.layout, readPane, 0) ?? parseFlatLayout(tab, readPane);
    if (!layout) continue;

    const panes = layoutPanes(layout);
    const activePaneId = panes.find((pane) => pane.id === tab.activePaneId)?.id ?? panes[0]!.id;
    const customTitle = typeof tab.customTitle === "string" ? tab.customTitle.trim() || undefined : undefined;
    const color = ansiHues.find((hue) => hue === tab.color);
    const locked = typeof tab.locked === "boolean" ? tab.locked : undefined;
    tabs.push({ id: tab.id, activePaneId, layout, customTitle, color, locked });
    tabIds.add(tab.id);
  }
  const activeId = isId(raw.activeId) && tabIds.has(raw.activeId) ? raw.activeId : tabs[0]?.id ?? null;
  return { tabs, activeId };
});

type ReadPane = (raw: unknown) => PaneLayout<SavedPane> | undefined;
type LayoutChild<P> = { layout: PaneLayout<P>; ratio: number };

function parsePane(raw: unknown): SavedPane | undefined {
  if (!isRecord(raw) || !isId(raw.id)) return undefined;
  const { id, kind } = raw;
  switch (kind) {
    case "home":
    case "settings":
      return { id, kind };
    case "local-terminal": {
      const { cwd } = raw;
      return typeof cwd === "string" && cwd.startsWith("/") && !cwd.includes("\0") ? { id, kind, cwd } : { id, kind };
    }
    case "remote-terminal":
    case "sftp":
    case "port-forwards": {
      const hostId = isId(raw.hostId) ? raw.hostId : isRecord(raw.host) ? raw.host.id : undefined;
      if (isId(hostId)) return { id, kind, hostId };
    }
  }
}

function parseLayout(raw: unknown, readPane: ReadPane, depth: number): PaneLayout<SavedPane> | undefined {
  if (!isRecord(raw) || depth > maxPanesPerTab) return undefined;
  if (raw.type === "pane") return readPane(raw.pane);
  if (raw.type !== "split" || !Array.isArray(raw.children)) return undefined;

  const children = raw.children.flatMap((child): LayoutChild<SavedPane>[] => {
    if (!isRecord(child)) return [];
    const layout = parseLayout(child.layout, readPane, depth + 1);
    return layout ? [{ layout, ratio: positiveRatio(child.ratio) }] : [];
  });
  return repairSplit(raw.orientation, children);
}

function parseFlatLayout(tab: Record<string, unknown>, readPane: ReadPane): PaneLayout<SavedPane> | undefined {
  if (!Array.isArray(tab.panes)) return undefined;
  const ratios: unknown[] = Array.isArray(tab.ratios) ? tab.ratios : [];
  const children = tab.panes.flatMap((pane, index): LayoutChild<SavedPane>[] => {
    const layout = readPane(pane);
    return layout ? [{ layout, ratio: positiveRatio(ratios[index]) }] : [];
  });
  return repairSplit(tab.orientation, children);
}

/** Empty branches are dropped, single children are promoted, and unusable sizes become equal. */
function repairSplit<P>(orientation: unknown, children: LayoutChild<P>[]): PaneLayout<P> | undefined {
  if (children.length < 2) return children[0]?.layout;
  const total = children.reduce((sum, child) => sum + child.ratio, 0);
  const valid = Number.isFinite(total) && children.every((child) => child.ratio / total > 0);
  return {
    type: "split",
    orientation: orientation === "vertical" ? "vertical" : "horizontal",
    children: children.map((child) => ({ ...child, ratio: valid ? child.ratio / total : 1 / children.length })),
  };
}

function positiveRatio(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^\S+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves saved Host ids against the current Host list and repairs the resulting gaps. */
export function restoreWorkspaceLayout(saved: WorkspaceLayout, hosts: readonly Host[], mode: RestoreTabs): TabsState {
  if (mode === "none") return startupTabs();

  const byId = new Map(hosts.map((host) => [host.id, host]));
  let order = 0;
  function restoreLayout(layout: PaneLayout<SavedPane>): PaneLayout | undefined {
    if (layout.type === "split") {
      const children = layout.children.flatMap(({ layout, ratio }) => {
        const restored = restoreLayout(layout);
        return restored ? [{ layout: restored, ratio }] : [];
      });
      return children.length === layout.children.length
        ? { ...layout, children }
        : repairSplit(layout.orientation, children);
    }
    const { pane } = layout;
    if (!("hostId" in pane)) return { type: "pane", pane };

    const host = byId.get(pane.hostId);
    if (!host) return undefined;
    const { id, kind } = pane;
    if (kind === "port-forwards") return { type: "pane", pane: { id, kind, host } };

    const restoreConnection = mode === "connect" ? { order: order++ } : "manual";
    return { type: "pane", pane: { id, kind, host, status: "disconnected", restoreConnection } };
  }

  const tabs = saved.tabs.flatMap((tab): Tab[] => {
    const layout = restoreLayout(tab.layout);
    if (!layout) return [];
    const panes = layoutPanes(layout);
    const activePaneId = panes.find((pane) => pane.id === tab.activePaneId)?.id ?? panes[0]!.id;
    return [{ ...tab, layout, activePaneId }];
  });
  const first = tabs[0];
  if (!first) return startupTabs();
  const activeId = tabs.some((tab) => tab.id === saved.activeId) ? saved.activeId : first.id;
  return { tabs, activeId };
}
