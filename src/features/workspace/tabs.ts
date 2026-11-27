import { hostHue } from "@/features/hosts/hostHue";
import type { TerminalTitleSource } from "@/features/terminal/terminal-prefs";
import type { Host } from "@/lib/ipc/hosts";
import type { AnsiHue } from "@/theme/monogram-ink";
import { paneNeighbors, resizePaneLayout, type PaneDirection, type SplitResize } from "./pane-layout";

/** A remote Terminal's link to its Host, shown as the state dot on its tab. */
export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/**
 * What a pane shows. Extend this union for new kinds and add a matching case in
 * `PaneContent` (`TabPanels.tsx`).
 */
export type PaneKind =
  /** The Host vault: search, recent and every Host as a card. One per window. */
  | { kind: "home" }
  | { kind: "local-terminal" }
  | { kind: "remote-terminal"; host: Host }
  | { kind: "sftp"; host: Host }
  | { kind: "settings" }
  /** A Host's Port forward rules; the panel reads the live Host by `host.id`. */
  | { kind: "port-forwards"; host: Host };

/**
 * What makes a pane one of a kind: opening another pane with the same key focuses the open
 * one. `undefined` for kinds that may be open many times.
 */
function singletonKey(pane: PaneKind): string | undefined {
  switch (pane.kind) {
    case "home":
      return "home";
    case "settings":
      return "settings";
    case "sftp":
      return `sftp:${pane.host.id}`;
    case "port-forwards":
      return `port-forwards:${pane.host.id}`;
    default:
      return undefined;
  }
}

/** One Terminal in a tab. A tab has one pane, or several side by side when split. */
export type Pane = {
  id: string;
  /** Title set by the program running in the pane (OSC 0/2), if any. */
  title?: string;
  /** Remote Terminals only. */
  status?: ConnectionStatus;
  /** A restored remote pane waits for a manual click or its turn in the startup queue. */
  restoreConnection?: "manual" | { order: number };
  /** While a dropped Connection is retried: which try this is, of how many. */
  reconnecting?: ReconnectProgress;
} & PaneKind;

export interface ReconnectProgress {
  attempt: number;
  attempts: number;
}

/** `horizontal` lays panes out left to right, `vertical` top to bottom. */
export type SplitOrientation = "horizontal" | "vertical";

export type PaneLayout<P = Pane> =
  | { type: "pane"; pane: P }
  | { type: "split"; orientation: SplitOrientation; children: { layout: PaneLayout<P>; ratio: number }[] };

export const maxPanesPerTab = 8;

export interface Tab {
  id: string;
  /** A nonempty tree. Closing the last pane closes an unlocked tab. */
  layout: PaneLayout;
  /** The pane with focus provides the automatic title and receives pane shortcuts. */
  activePaneId: string;
  /** Temporarily show only the focused pane without changing the layout. */
  paneMaximized?: true;
  /** A tab title that takes precedence over the focused pane's automatic title. */
  customTitle?: string;
  color?: AnsiHue;
  locked?: boolean;
}

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
}

export type TabCustomizationAction =
  | { type: "renameTab"; id: string; title: string }
  | { type: "setTabColor"; id: string; color: AnsiHue | undefined }
  | { type: "setTabLocked"; id: string; locked: boolean };

export type TabsAction =
  | TabCustomizationAction
  | { type: "open"; tabId: string; pane: Pane }
  | { type: "close"; id: string }
  | { type: "closeOthers"; id: string }
  | { type: "closeRight"; id: string }
  | { type: "activate"; id: string }
  | { type: "cycle"; step: 1 | -1 }
  | { type: "move"; id: string; to: number }
  | { type: "split"; orientation: SplitOrientation; pane: Pane; paneId?: string }
  | ({ type: "resizeSplit"; tabId: string } & SplitResize)
  | { type: "focusPane"; paneId: string }
  | { type: "cyclePane"; step: 1 | -1 }
  | { type: "toggleMaximizePane" }
  | { type: "swapPane"; direction: PaneDirection }
  | { type: "closePane"; paneId: string }
  | { type: "connectRestoredPane"; paneId: string }
  | { type: "retitle"; paneId: string; title: string }
  | { type: "status"; paneId: string; status: ConnectionStatus; reconnecting?: ReconnectProgress };

export const emptyTabs: TabsState = { tabs: [], activeId: null };

/** What the app opens with: the Home tab, no Terminal. */
export function startupTabs(): TabsState {
  return tabsReducer(emptyTabs, { type: "open", tabId: crypto.randomUUID(), pane: newPane({ kind: "home" }) });
}

/** Terminals and panes that can open a Local terminal next to them, up to the tab's limit. */
export function canSplit(tab: Tab, paneId = tab.activePaneId): boolean {
  const panes = tabPanes(tab);
  const pane = panes.find((candidate) => candidate.id === paneId);
  return panes.length < maxPanesPerTab && pane !== undefined && pane.kind !== "sftp" && pane.kind !== "home";
}

/** DOM ids linking a tab to its panel (aria-controls / aria-labelledby). */
export const tabId = (id: string) => `tab-${id}`;
export const tabPanelId = (id: string) => `tabpanel-${id}`;

/** A pane for `kind`; a remote Terminal starts out connecting. */
export function newPane(kind: PaneKind, id: string = crypto.randomUUID()): Pane {
  return kind.kind === "remote-terminal" || kind.kind === "sftp" ? { id, ...kind, status: "connecting" } : { id, ...kind };
}

/** Leaves in layout order, shared by the tab UI and previous/next pane shortcuts. */
export function layoutPanes<P>(layout: PaneLayout<P>): P[] {
  return layout.type === "pane" ? [layout.pane] : layout.children.flatMap((child) => layoutPanes(child.layout));
}

export function tabPanes(tab: Tab): Pane[] {
  return layoutPanes(tab.layout);
}

/** The next restored remote pane connects only after the previous attempt settles. */
export function nextRestoreConnection(tabs: readonly Tab[]): string | undefined {
  let next: { id: string; order: number } | undefined;
  for (const { id, restoreConnection } of tabs.flatMap(tabPanes)) {
    if (typeof restoreConnection === "object" && (!next || restoreConnection.order < next.order)) {
      next = { id, order: restoreConnection.order };
    }
  }
  return next?.id;
}

export function activePane(tab: Tab): Pane {
  const panes = tabPanes(tab);
  return panes.find((pane) => pane.id === tab.activePaneId) ?? panes[0]!;
}

export function activeTab(state: TabsState): Tab | undefined {
  return state.tabs.find((tab) => tab.id === state.activeId);
}

/** The Connection status the tab shows: its focused pane's, if that is a remote Terminal. */
export function tabStatus(tab: Tab): ConnectionStatus | undefined {
  return activePane(tab).status;
}

export function tabHue(tab: Tab): AnsiHue | undefined {
  if (tab.color) return tab.color;
  const pane = activePane(tab);
  return "host" in pane ? hostHue(pane.host.id) : undefined;
}

/** Hosts with at least one connected Terminal, each once, in tab order. */
export function connectedHosts(state: TabsState): Host[] {
  const hosts = new Map<string, Host>();
  for (const pane of state.tabs.flatMap(tabPanes)) {
    if ((pane.kind === "remote-terminal" || pane.kind === "sftp") && pane.status === "connected" && !hosts.has(pane.host.id)) {
      hosts.set(pane.host.id, pane.host);
    }
  }
  return [...hosts.values()];
}

/** Hosts whose Terminals are retrying a dropped Connection, each once with its furthest try, in tab order. */
export function reconnectingHosts(state: TabsState): ({ host: Host } & ReconnectProgress)[] {
  const hosts = new Map<string, { host: Host } & ReconnectProgress>();
  for (const pane of state.tabs.flatMap(tabPanes)) {
    if (pane.kind !== "remote-terminal" || !pane.reconnecting) continue;
    const seen = hosts.get(pane.host.id);
    if (!seen || pane.reconnecting.attempt > seen.attempt) hosts.set(pane.host.id, { host: pane.host, ...pane.reconnecting });
  }
  return [...hosts.values()];
}

/** Every open remote Terminal pane's id; a File panel whose pane is not listed is closed. */
export function remoteTerminalPaneIds(state: TabsState): string[] {
  return state.tabs.flatMap(tabPanes).filter((pane) => pane.kind === "remote-terminal").map((pane) => pane.id);
}

/**
 * The tab's custom title or its focused pane's automatic label. In shell mode, a program's title
 * takes priority over the kind's name. `ordinal` is 1-based among tabs of the same kind.
 */
export function tabTitle(
  tab: Tab,
  t: (key: "tabs.home" | "tabs.localTerminal" | "tabs.settings" | "tabs.portForwards" | "tabs.sftp") => string,
  ordinal: number,
  titleSource: TerminalTitleSource = "shell",
): string {
  if (tab.customTitle) return tab.customTitle;
  const pane = activePane(tab);
  if (titleSource === "shell" && pane.title) return pane.title;
  switch (pane.kind) {
    case "home":
      return t("tabs.home");
    case "local-terminal": {
      const name = t("tabs.localTerminal");
      return ordinal > 1 ? `${name} ${ordinal}` : name;
    }
    case "remote-terminal":
      return pane.host.name;
    case "sftp":
      return `${t("tabs.sftp")} · ${pane.host.name}`;
    case "settings":
      return t("tabs.settings");
    case "port-forwards":
      return `${t("tabs.portForwards")} · ${pane.host.name}`;
  }
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "open": {
      const key = singletonKey(action.pane);
      if (key) {
        const open = state.tabs.flatMap(tabPanes).find((pane) => singletonKey(pane) === key);
        if (open) return tabsReducer(state, { type: "focusPane", paneId: open.id });
      }
      const tab: Tab = {
        id: action.tabId,
        layout: { type: "pane", pane: action.pane },
        activePaneId: action.pane.id,
      };
      return { tabs: [...state.tabs, tab], activeId: tab.id };
    }
    case "close":
    case "closeOthers":
    case "closeRight":
      return closeTabs(state, action.id, action.type);
    case "renameTab":
      return updateTab(state, action.id, { customTitle: action.title.trim() || undefined });
    case "setTabColor":
      return updateTab(state, action.id, { color: action.color });
    case "setTabLocked":
      return updateTab(state, action.id, { locked: action.locked });
    case "activate":
      if (!state.tabs.some((t) => t.id === action.id)) return state;
      return { ...state, activeId: action.id };
    case "cycle": {
      const count = state.tabs.length;
      if (count === 0) return state;
      const index = state.tabs.findIndex((t) => t.id === state.activeId);
      const next = state.tabs[(index + action.step + count) % count];
      return { ...state, activeId: next?.id ?? null };
    }
    case "move": {
      const from = state.tabs.findIndex((t) => t.id === action.id);
      const to = Math.max(0, Math.min(action.to, state.tabs.length - 1));
      if (from === -1 || from === to) return state;
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved!);
      return { ...state, tabs };
    }
    case "split": {
      const tab = action.paneId === undefined ? activeTab(state) : tabOfPane(state, action.paneId);
      if (!tab || !canSplit(tab, action.paneId) || tabOfPane(state, action.pane.id)) return state;
      const layout = replaceLeaf(tab.layout, action.paneId ?? tab.activePaneId, (pane) => ({
        type: "split",
        orientation: action.orientation,
        children: [
          { ratio: 0.5, layout: { type: "pane", pane } },
          { ratio: 0.5, layout: { type: "pane", pane: action.pane } },
        ],
      }))!;
      return { ...replaceTab(state, { ...tab, layout, activePaneId: action.pane.id, paneMaximized: undefined }), activeId: tab.id };
    }
    case "resizeSplit": {
      const tab = state.tabs.find((tab) => tab.id === action.tabId);
      if (!tab || tab.paneMaximized) return state;
      const layout = resizePaneLayout(tab.layout, action);
      return layout === tab.layout ? state : replaceTab(state, { ...tab, layout });
    }
    case "focusPane": {
      const tab = tabOfPane(state, action.paneId);
      if (!tab) return state;
      const paneMaximized = tab.activePaneId === action.paneId ? tab.paneMaximized : undefined;
      return { ...replaceTab(state, { ...tab, activePaneId: action.paneId, paneMaximized }), activeId: tab.id };
    }
    case "cyclePane": {
      const tab = activeTab(state);
      if (!tab) return state;
      const panes = tabPanes(tab);
      const count = panes.length;
      const index = panes.findIndex((pane) => pane.id === tab.activePaneId);
      const next = panes[(index + action.step + count) % count]!;
      return replaceTab(state, { ...tab, activePaneId: next.id, paneMaximized: undefined });
    }
    case "toggleMaximizePane": {
      const tab = activeTab(state);
      if (tab?.layout.type !== "split") return state;
      return replaceTab(state, { ...tab, paneMaximized: tab.paneMaximized ? undefined : true });
    }
    case "swapPane": {
      const tab = activeTab(state);
      if (!tab) return state;
      const focused = activePane(tab);
      const neighbor = paneNeighbors(tab.layout, focused.id)[action.direction];
      if (!neighbor) return state;
      const layout = mapLeaves(tab.layout, (leaf) => {
        if (leaf.pane.id === focused.id) return { type: "pane", pane: neighbor };
        if (leaf.pane.id === neighbor.id) return { type: "pane", pane: focused };
        return leaf;
      })!;
      return replaceTab(state, { ...tab, layout });
    }
    case "closePane": {
      const tab = tabOfPane(state, action.paneId);
      if (!tab) return state;
      const layout = replaceLeaf(tab.layout, action.paneId, () => undefined);
      if (!layout) return closeTabs(state, tab.id, "close");
      const index = tabPanes(tab).findIndex((pane) => pane.id === action.paneId);
      const panes = layoutPanes(layout);
      const activePaneId =
        tab.activePaneId === action.paneId ? panes[Math.min(index, panes.length - 1)]!.id : tab.activePaneId;
      return replaceTab(state, { ...tab, layout, activePaneId, paneMaximized: undefined });
    }
    case "retitle": {
      const title = action.title.trim() || undefined;
      return updatePane(state, action.paneId, (pane) => ({ ...pane, title }));
    }
    case "connectRestoredPane":
      return updatePane(state, action.paneId, (pane) => pane.restoreConnection === "manual"
        ? { ...pane, restoreConnection: undefined, status: "connecting" }
        : pane);
    case "status":
      return updatePane(state, action.paneId, (pane) => ({
        ...pane,
        status: action.status,
        restoreConnection: action.status === "connecting" ? pane.restoreConnection : undefined,
        reconnecting: action.reconnecting,
      }));
  }
}

function closeTabs(state: TabsState, id: string, mode: "close" | "closeOthers" | "closeRight"): TabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab, at) => {
    if (tab.locked) return true;
    if (mode === "closeOthers") return at === index;
    if (mode === "closeRight") return at <= index;
    return at !== index;
  });
  if (tabs.length === state.tabs.length) return state;
  if (state.activeId === null || tabs.some((tab) => tab.id === state.activeId)) return { tabs, activeId: state.activeId };
  const next = mode === "close" ? tabs[Math.min(index, tabs.length - 1)]?.id : id;
  return { tabs, activeId: next ?? null };
}

function tabOfPane(state: TabsState, paneId: string): Tab | undefined {
  return state.tabs.find((tab) => tabPanes(tab).some((pane) => pane.id === paneId));
}

function replaceTab(state: TabsState, next: Tab): TabsState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === next.id ? next : tab)) };
}

function updateTab(state: TabsState, id: string, changes: Partial<Tab>): TabsState {
  const tab = state.tabs.find((tab) => tab.id === id);
  return tab ? replaceTab(state, { ...tab, ...changes }) : state;
}

function updatePane(state: TabsState, paneId: string, update: (pane: Pane) => Pane): TabsState {
  const tab = tabOfPane(state, paneId);
  if (!tab) return state;
  return replaceTab(state, {
    ...tab,
    layout: replaceLeaf(tab.layout, paneId, (pane) => ({ type: "pane", pane: update(pane) }))!,
  });
}

function replaceLeaf(layout: PaneLayout, paneId: string, replace: (pane: Pane) => PaneLayout | undefined): PaneLayout | undefined {
  return mapLeaves(layout, (leaf) => leaf.pane.id === paneId ? replace(leaf.pane) : leaf);
}

function mapLeaves(
  layout: PaneLayout,
  replace: (leaf: Extract<PaneLayout, { type: "pane" }>) => PaneLayout | undefined,
): PaneLayout | undefined {
  if (layout.type === "pane") return replace(layout);
  const children = layout.children.flatMap((child) => {
    const next = mapLeaves(child.layout, replace);
    if (next === undefined) return [];
    return [next === child.layout ? child : { ...child, layout: next }];
  });
  if (children.length === 1) return children[0]!.layout;
  if (children.length < layout.children.length) {
    const total = children.reduce((sum, child) => sum + child.ratio, 0);
    return { ...layout, children: children.map((child) => ({ ...child, ratio: child.ratio / total })) };
  }
  return children.every((child, index) => child === layout.children[index]) ? layout : { ...layout, children };
}
