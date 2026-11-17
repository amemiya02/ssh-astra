/**
 * What a tab in the workspace shows. Extend this union for new kinds (a remote
 * Terminal on a Host, ...) and add a matching case in `TabContent`.
 */
export type Tab = { id: string; kind: "local-terminal" };

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
}

export type TabsAction =
  | { type: "open"; tab: Tab }
  | { type: "close"; id: string }
  | { type: "activate"; id: string }
  | { type: "cycle"; step: 1 | -1 };

export const emptyTabs: TabsState = { tabs: [], activeId: null };

/** DOM ids linking a tab to its panel (aria-controls / aria-labelledby). */
export const tabId = (id: string) => `tab-${id}`;
export const tabPanelId = (id: string) => `tabpanel-${id}`;

/** The tab's label. Remote Terminals will use the Host name. */
export function tabTitle(tab: Tab, t: (key: "tabs.localTerminal") => string): string {
  switch (tab.kind) {
    case "local-terminal":
      return t("tabs.localTerminal");
  }
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "open":
      return { tabs: [...state.tabs, action.tab], activeId: action.tab.id };
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
  }
}
