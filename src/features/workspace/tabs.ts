import type { Host } from "@/lib/ipc/hosts";

/**
 * What a tab in the workspace shows. Extend this union for new kinds and add a
 * matching case in `TabContent`.
 */
export type Tab = {
  id: string;
  /** Title set by the program running in the tab (OSC 0/2), if any. */
  title?: string;
} & ({ kind: "local-terminal" } | { kind: "remote-terminal"; host: Host } | { kind: "settings" });

/** Kinds with at most one tab: opening another focuses the open one. */
const singletonKinds: ReadonlySet<Tab["kind"]> = new Set(["settings"]);

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
}

export type TabsAction =
  | { type: "open"; tab: Tab }
  | { type: "close"; id: string }
  | { type: "activate"; id: string }
  | { type: "cycle"; step: 1 | -1 }
  | { type: "retitle"; id: string; title: string };

export const emptyTabs: TabsState = { tabs: [], activeId: null };

/** DOM ids linking a tab to its panel (aria-controls / aria-labelledby). */
export const tabId = (id: string) => `tab-${id}`;
export const tabPanelId = (id: string) => `tabpanel-${id}`;

/**
 * The tab's label: the program's own title, else the kind's name, numbered from the second
 * tab of that kind (`ordinal` is 1-based among tabs of the same kind). A remote Terminal
 * uses its Host's name.
 */
export function tabTitle(
  tab: Tab,
  t: (key: "tabs.localTerminal" | "tabs.settings") => string,
  ordinal: number,
): string {
  if (tab.title) return tab.title;
  switch (tab.kind) {
    case "local-terminal": {
      const name = t("tabs.localTerminal");
      return ordinal > 1 ? `${name} ${ordinal}` : name;
    }
    case "remote-terminal":
      return tab.host.name;
    case "settings":
      return t("tabs.settings");
  }
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "open": {
      const open = singletonKinds.has(action.tab.kind) && state.tabs.find((t) => t.kind === action.tab.kind);
      if (open) return { ...state, activeId: open.id };
      return { tabs: [...state.tabs, action.tab], activeId: action.tab.id };
    }
    case "close": {
      const index = state.tabs.findIndex((t) => t.id === action.id);
      if (index === -1) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      if (state.activeId !== action.id) return { tabs, activeId: state.activeId };
      const next = tabs[Math.min(index, tabs.length - 1)];
      return { tabs, activeId: next?.id ?? null };
    }
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
    case "retitle": {
      const title = action.title.trim() || undefined;
      return {
        ...state,
        tabs: state.tabs.map((tab) => (tab.id === action.id ? { ...tab, title } : tab)),
      };
    }
  }
}
