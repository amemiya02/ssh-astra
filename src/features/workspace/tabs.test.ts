import { describe, expect, it } from "vitest";
import type { Host } from "@/lib/ipc/hosts";
import {
  connectedHosts,
  emptyTabs,
  newPane,
  tabsReducer,
  tabStatus,
  tabTitle,
  type Pane,
  type Tab,
  type TabsState,
} from "./tabs";

const host = (id: string, name = id): Host => ({
  id,
  name,
  address: "10.0.0.5",
  port: 22,
  user: "deploy",
  auth: { type: "password" },
  jumpHost: null,
  groupId: null,
});

const local = (id: string): Pane => ({ id, kind: "local-terminal" });
const remote = (id: string, on: Host, status: Pane["status"] = "connecting"): Pane => ({
  id,
  kind: "remote-terminal",
  host: on,
  status,
});
const tab = (id: string, panes: Pane[] = [local(`${id}.1`)]): Tab => ({
  id,
  panes,
  activePaneId: panes[0]!.id,
  orientation: "horizontal",
});

function withTabs(ids: string[], activeId: string): TabsState {
  return { tabs: ids.map((id) => tab(id)), activeId };
}

const ids = (state: TabsState) => state.tabs.map((t) => t.id);
const paneIds = (state: TabsState, tabId: string) =>
  state.tabs.find((t) => t.id === tabId)?.panes.map((p) => p.id);

describe("tabsReducer: tabs", () => {
  it("opens a pane in a new tab at the end and focuses it", () => {
    const state = tabsReducer(withTabs(["a"], "a"), { type: "open", tabId: "b", pane: local("b.1") });
    expect(ids(state)).toEqual(["a", "b"]);
    expect(state.activeId).toBe("b");
    expect(state.tabs[1]).toEqual(tab("b", [local("b.1")]));
  });

  it("opening Settings again focuses the open Settings tab instead of adding a second", () => {
    const settings = (id: string): Pane => ({ id, kind: "settings" });
    const opened = tabsReducer(withTabs(["a"], "a"), { type: "open", tabId: "s1", pane: settings("s1.1") });
    const back = tabsReducer(opened, { type: "activate", id: "a" });
    const again = tabsReducer(back, { type: "open", tabId: "s2", pane: settings("s2.1") });
    expect(ids(again)).toEqual(["a", "s1"]);
    expect(again.activeId).toBe("s1");
  });

  it("closing the active tab focuses the tab to its right, like a browser", () => {
    const state = tabsReducer(withTabs(["a", "b", "c"], "b"), { type: "close", id: "b" });
    expect(state).toEqual(withTabs(["a", "c"], "c"));
  });

  it("closing the last tab in the strip focuses the one before it", () => {
    const state = tabsReducer(withTabs(["a", "b", "c"], "c"), { type: "close", id: "c" });
    expect(state).toEqual(withTabs(["a", "b"], "b"));
  });

  it("closing a background tab keeps the current focus", () => {
    const state = tabsReducer(withTabs(["a", "b", "c"], "c"), { type: "close", id: "a" });
    expect(state).toEqual(withTabs(["b", "c"], "c"));
  });

  it("closing the only tab leaves nothing active", () => {
    expect(tabsReducer(withTabs(["a"], "a"), { type: "close", id: "a" })).toEqual(emptyTabs);
  });

  it("ignores closing a tab that is not open", () => {
    const state = withTabs(["a"], "a");
    expect(tabsReducer(state, { type: "close", id: "zzz" })).toBe(state);
  });

  it("activates a tab by id, ignoring unknown ids", () => {
    expect(tabsReducer(withTabs(["a", "b"], "a"), { type: "activate", id: "b" }).activeId).toBe("b");
    const state = withTabs(["a", "b"], "a");
    expect(tabsReducer(state, { type: "activate", id: "zzz" })).toBe(state);
  });

  it("cycles through tabs and wraps around at both ends", () => {
    const state = withTabs(["a", "b", "c"], "c");
    expect(tabsReducer(state, { type: "cycle", step: 1 }).activeId).toBe("a");
    expect(tabsReducer(state, { type: "cycle", step: -1 }).activeId).toBe("b");
    expect(tabsReducer(withTabs(["a", "b"], "a"), { type: "cycle", step: -1 }).activeId).toBe("b");
  });

  it("does nothing when cycling with no tabs", () => {
    expect(tabsReducer(emptyTabs, { type: "cycle", step: 1 })).toBe(emptyTabs);
  });

  it("moves a dragged tab to a new position, keeping it active", () => {
    const state = withTabs(["a", "b", "c", "d"], "a");
    expect(ids(tabsReducer(state, { type: "move", id: "a", to: 2 }))).toEqual(["b", "c", "a", "d"]);
    expect(ids(tabsReducer(state, { type: "move", id: "d", to: 0 }))).toEqual(["d", "a", "b", "c"]);
    expect(tabsReducer(state, { type: "move", id: "a", to: 2 }).activeId).toBe("a");
  });

  it("clamps a move past either end and ignores unknown or unmoved tabs", () => {
    const state = withTabs(["a", "b", "c"], "a");
    expect(ids(tabsReducer(state, { type: "move", id: "a", to: 99 }))).toEqual(["b", "c", "a"]);
    expect(ids(tabsReducer(state, { type: "move", id: "c", to: -5 }))).toEqual(["c", "a", "b"]);
    expect(tabsReducer(state, { type: "move", id: "zzz", to: 0 })).toBe(state);
    expect(tabsReducer(state, { type: "move", id: "b", to: 1 })).toBe(state);
  });
});

describe("tabsReducer: splits", () => {
  it("splits the active pane, placing the new pane after it and focusing it", () => {
    const state = tabsReducer(withTabs(["a"], "a"), {
      type: "split",
      orientation: "vertical",
      pane: local("a.2"),
    });
    expect(paneIds(state, "a")).toEqual(["a.1", "a.2"]);
    expect(state.tabs[0]).toMatchObject({ activePaneId: "a.2", orientation: "vertical" });
  });

  it("inserts next to the active pane, and a later split sets the orientation for the whole tab", () => {
    let state = tabsReducer(withTabs(["a"], "a"), { type: "split", orientation: "horizontal", pane: local("a.2") });
    state = tabsReducer(state, { type: "focusPane", paneId: "a.1" });
    state = tabsReducer(state, { type: "split", orientation: "vertical", pane: local("a.3") });
    expect(paneIds(state, "a")).toEqual(["a.1", "a.3", "a.2"]);
    expect(state.tabs[0]).toMatchObject({ activePaneId: "a.3", orientation: "vertical" });
  });

  it("does nothing when splitting with no tab open", () => {
    expect(tabsReducer(emptyTabs, { type: "split", orientation: "horizontal", pane: local("x") })).toBe(emptyTabs);
  });

  it("focusing a pane also brings its tab to the front", () => {
    const state: TabsState = { tabs: [tab("a"), tab("b", [local("b.1"), local("b.2")])], activeId: "a" };
    const next = tabsReducer(state, { type: "focusPane", paneId: "b.2" });
    expect(next.activeId).toBe("b");
    expect(next.tabs[1]?.activePaneId).toBe("b.2");
    expect(tabsReducer(state, { type: "focusPane", paneId: "zzz" })).toBe(state);
  });

  it("cycles focus through the active tab's panes", () => {
    const state: TabsState = { tabs: [tab("a", [local("a.1"), local("a.2"), local("a.3")])], activeId: "a" };
    expect(tabsReducer(state, { type: "cyclePane", step: 1 }).tabs[0]?.activePaneId).toBe("a.2");
    expect(tabsReducer(state, { type: "cyclePane", step: -1 }).tabs[0]?.activePaneId).toBe("a.3");
  });

  it("closing a pane focuses its neighbour and keeps the tab", () => {
    const state: TabsState = {
      tabs: [{ ...tab("a", [local("a.1"), local("a.2"), local("a.3")]), activePaneId: "a.2" }],
      activeId: "a",
    };
    const next = tabsReducer(state, { type: "closePane", paneId: "a.2" });
    expect(paneIds(next, "a")).toEqual(["a.1", "a.3"]);
    expect(next.tabs[0]?.activePaneId).toBe("a.3");
  });

  it("closing a background pane keeps the focused one", () => {
    const state: TabsState = { tabs: [tab("a", [local("a.1"), local("a.2")])], activeId: "a" };
    expect(tabsReducer(state, { type: "closePane", paneId: "a.2" }).tabs[0]?.activePaneId).toBe("a.1");
  });

  it("closing a tab's last pane closes the tab", () => {
    const state = withTabs(["a", "b"], "b");
    expect(tabsReducer(state, { type: "closePane", paneId: "b.1" })).toEqual(withTabs(["a"], "a"));
  });
});

describe("tabsReducer: pane state", () => {
  it("retitles a pane when its shell sets a title, and clears it on an empty title", () => {
    const titled = tabsReducer(withTabs(["a", "b"], "a"), { type: "retitle", paneId: "b.1", title: "vim notes.md" });
    expect(titled.tabs[1]?.panes[0]).toEqual({ id: "b.1", kind: "local-terminal", title: "vim notes.md" });
    const cleared = tabsReducer(titled, { type: "retitle", paneId: "b.1", title: "  " });
    expect(cleared.tabs[1]?.panes[0]?.title).toBeUndefined();
  });

  it("records a remote Terminal's Connection status as it changes", () => {
    const web = host("web");
    let state = tabsReducer(emptyTabs, { type: "open", tabId: "a", pane: remote("a.1", web) });
    expect(tabStatus(state.tabs[0]!)).toBe("connecting");
    state = tabsReducer(state, { type: "status", paneId: "a.1", status: "connected" });
    expect(tabStatus(state.tabs[0]!)).toBe("connected");
    state = tabsReducer(state, { type: "status", paneId: "a.1", status: "disconnected" });
    expect(tabStatus(state.tabs[0]!)).toBe("disconnected");
  });
});

describe("newPane", () => {
  it("starts a remote Terminal as connecting, and a Local terminal with no Connection status", () => {
    const web = host("web");
    expect(newPane({ kind: "remote-terminal", host: web }, "p")).toEqual(remote("p", web, "connecting"));
    expect(newPane({ kind: "local-terminal" }, "q")).toEqual(local("q"));
  });
});

describe("tabStatus", () => {
  it("is the focused pane's status, and none for a Local terminal", () => {
    const web = host("web");
    const mixed: Tab = { ...tab("a", [remote("a.1", web, "connected"), local("a.2")]), activePaneId: "a.2" };
    expect(tabStatus(mixed)).toBeUndefined();
    expect(tabStatus({ ...mixed, activePaneId: "a.1" })).toBe("connected");
  });
});

describe("connectedHosts", () => {
  it("lists each Host with a connected Terminal once, in tab order", () => {
    const web = host("web", "web-1");
    const db = host("db", "db-1");
    const cache = host("cache", "cache-1");
    const state: TabsState = {
      tabs: [
        tab("a", [remote("a.1", web, "connected"), remote("a.2", web, "connected")]),
        tab("b", [remote("b.1", cache, "disconnected"), local("b.2")]),
        tab("c", [remote("c.1", db, "connected"), remote("c.2", web, "connecting")]),
      ],
      activeId: "a",
    };
    expect(connectedHosts(state).map((h) => h.name)).toEqual(["web-1", "db-1"]);
    expect(connectedHosts(emptyTabs)).toEqual([]);
  });
});

describe("tabTitle", () => {
  const t = (key: "tabs.localTerminal" | "tabs.settings") => (key === "tabs.settings" ? "Settings" : "Local terminal");

  it("names the Settings tab", () => {
    expect(tabTitle(tab("s", [{ id: "s.1", kind: "settings" }]), t, 1)).toBe("Settings");
  });

  it("numbers Local terminals after the first so tabs stay distinguishable", () => {
    expect(tabTitle(tab("a"), t, 1)).toBe("Local terminal");
    expect(tabTitle(tab("b"), t, 2)).toBe("Local terminal 2");
  });

  it("prefers the title the focused pane's shell set", () => {
    const titled = tab("a", [local("a.1"), { ...local("a.2"), title: "htop" }]);
    expect(tabTitle({ ...titled, activePaneId: "a.2" }, t, 2)).toBe("htop");
    expect(tabTitle(titled, t, 1)).toBe("Local terminal");
  });

  it("names a remote Terminal after its Host", () => {
    expect(tabTitle(tab("r", [remote("r.1", host("h", "web-1"))]), t, 1)).toBe("web-1");
  });
});

describe("emptyTabs", () => {
  it("has no tabs and nothing active", () => {
    expect(emptyTabs).toEqual({ tabs: [], activeId: null });
  });
});
