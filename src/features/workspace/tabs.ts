import type { Host } from "@/lib/ipc/hosts";

/** A remote Terminal's link to its Host, shown as the state dot on its tab. */
export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/**
 * What a pane shows. Extend this union for new kinds and add a matching case in
 * `PaneContent` (`TabPanels.tsx`).
 */
export type PaneKind =
  | { kind: "local-terminal" }
  | { kind: "remote-terminal"; host: Host }
  | { kind: "settings" }
  /** A Host's Port forward rules; the panel reads the live Host by `host.id`. */
  | { kind: "port-forwards"; host: Host };

/**
 * What makes a pane one of a kind: opening another pane with the same key focuses the open
 * one. `undefined` for kinds that may be open many times.
 */
function singletonKey(pane: PaneKind): string | undefined {
  switch (pane.kind) {
    case "settings":
      return "settings";
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
} & PaneKind;

/** `horizontal` lays panes out left to right, `vertical` top to bottom. */
export type SplitOrientation = "horizontal" | "vertical";

export interface Tab {
  id: string;
  /** Never empty: closing the last pane closes the tab. */
  panes: Pane[];
  /** The pane with focus; it names the tab and receives the pane shortcuts. */
  activePaneId: string;
  orientation: SplitOrientation;
}

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
}

export type TabsAction =
  | { type: "open"; tabId: string; pane: Pane }
  | { type: "close"; id: string }
  | { type: "activate"; id: string }
  | { type: "cycle"; step: 1 | -1 }
  | { type: "move"; id: string; to: number }
  | { type: "split"; orientation: SplitOrientation; pane: Pane }
  | { type: "focusPane"; paneId: string }
  | { type: "cyclePane"; step: 1 | -1 }
  | { type: "closePane"; paneId: string }
  | { type: "retitle"; paneId: string; title: string }
  | { type: "status"; paneId: string; status: ConnectionStatus };

export const emptyTabs: TabsState = { tabs: [], activeId: null };

/** DOM ids linking a tab to its panel (aria-controls / aria-labelledby). */
export const tabId = (id: string) => `tab-${id}`;
export const tabPanelId = (id: string) => `tabpanel-${id}`;

/** A pane for `kind`; a remote Terminal starts out connecting. */
export function newPane(kind: PaneKind, id: string = crypto.randomUUID()): Pane {
  return kind.kind === "remote-terminal" ? { id, ...kind, status: "connecting" } : { id, ...kind };
}

export function activePane(tab: Tab): Pane {
  return tab.panes.find((pane) => pane.id === tab.activePaneId) ?? tab.panes[0]!;
}

export function activeTab(state: TabsState): Tab | undefined {
  return state.tabs.find((tab) => tab.id === state.activeId);
}

/** The Connection status the tab shows: its focused pane's, if that is a remote Terminal. */
export function tabStatus(tab: Tab): ConnectionStatus | undefined {
  return activePane(tab).status;
}

/** Hosts with at least one connected Terminal, each once, in tab order. */
export function connectedHosts(state: TabsState): Host[] {
  const hosts = new Map<string, Host>();
  for (const pane of state.tabs.flatMap((tab) => tab.panes)) {
    if (pane.kind === "remote-terminal" && pane.status === "connected" && !hosts.has(pane.host.id)) {
      hosts.set(pane.host.id, pane.host);
    }
  }
  return [...hosts.values()];
}

/**
 * The tab's label, from its focused pane: the program's own title, else the kind's name,
 * numbered from the second tab of that kind (`ordinal` is 1-based among tabs of the same
 * kind). A remote Terminal uses its Host's name; a Port forwards tab adds it.
 */
export function tabTitle(
  tab: Tab,
  t: (key: "tabs.localTerminal" | "tabs.settings" | "tabs.portForwards") => string,
  ordinal: number,
): string {
  const pane = activePane(tab);
  if (pane.title) return pane.title;
  switch (pane.kind) {
    case "local-terminal": {
      const name = t("tabs.localTerminal");
      return ordinal > 1 ? `${name} ${ordinal}` : name;
    }
    case "remote-terminal":
      return pane.host.name;
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
        const open = state.tabs.flatMap((t) => t.panes).find((pane) => singletonKey(pane) === key);
        if (open) return tabsReducer(state, { type: "focusPane", paneId: open.id });
      }
      const tab: Tab = {
        id: action.tabId,
        panes: [action.pane],
        activePaneId: action.pane.id,
        orientation: "horizontal",
      };
      return { tabs: [...state.tabs, tab], activeId: tab.id };
    }
    case "close":
      return closeTab(state, action.id);
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
      const tab = activeTab(state);
      if (!tab) return state;
      const at = tab.panes.findIndex((pane) => pane.id === tab.activePaneId) + 1;
      const panes = [...tab.panes.slice(0, at), action.pane, ...tab.panes.slice(at)];
      return replaceTab(state, { ...tab, panes, activePaneId: action.pane.id, orientation: action.orientation });
    }
    case "focusPane": {
      const tab = tabOfPane(state, action.paneId);
      if (!tab) return state;
      return { ...replaceTab(state, { ...tab, activePaneId: action.paneId }), activeId: tab.id };
    }
    case "cyclePane": {
      const tab = activeTab(state);
      if (!tab) return state;
      const count = tab.panes.length;
      const index = tab.panes.findIndex((pane) => pane.id === tab.activePaneId);
      const next = tab.panes[(index + action.step + count) % count]!;
      return replaceTab(state, { ...tab, activePaneId: next.id });
    }
    case "closePane": {
      const tab = tabOfPane(state, action.paneId);
      if (!tab) return state;
      if (tab.panes.length === 1) return closeTab(state, tab.id);
      const index = tab.panes.findIndex((pane) => pane.id === action.paneId);
      const panes = tab.panes.filter((pane) => pane.id !== action.paneId);
      const activePaneId =
        tab.activePaneId === action.paneId ? panes[Math.min(index, panes.length - 1)]!.id : tab.activePaneId;
      return replaceTab(state, { ...tab, panes, activePaneId });
    }
    case "retitle": {
      const title = action.title.trim() || undefined;
      return updatePane(state, action.paneId, (pane) => ({ ...pane, title }));
    }
    case "status":
      return updatePane(state, action.paneId, (pane) => ({ ...pane, status: action.status }));
  }
}

function closeTab(state: TabsState, id: string): TabsState {
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  if (state.activeId !== id) return { tabs, activeId: state.activeId };
  const next = tabs[Math.min(index, tabs.length - 1)];
  return { tabs, activeId: next?.id ?? null };
}

function tabOfPane(state: TabsState, paneId: string): Tab | undefined {
  return state.tabs.find((tab) => tab.panes.some((pane) => pane.id === paneId));
}

function replaceTab(state: TabsState, next: Tab): TabsState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === next.id ? next : tab)) };
}

function updatePane(state: TabsState, paneId: string, update: (pane: Pane) => Pane): TabsState {
  const tab = tabOfPane(state, paneId);
  if (!tab) return state;
  return replaceTab(state, {
    ...tab,
    panes: tab.panes.map((pane) => (pane.id === paneId ? update(pane) : pane)),
  });
}
