import { describe, expect, it } from "vitest";
import { groupTabsByHost } from "./tab-groups";
import type { Host } from "@/lib/ipc/hosts";
import {
  activePane,
  connectedHosts,
  canSplit,
  emptyTabs,
  reconnectingHosts,
  startupTabs,
  newPane,
  tabPanes,
  tabHue,
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
  forwards: [],
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
  layout: panes.length === 1
    ? { type: "pane", pane: panes[0]! }
    : {
        type: "split",
        orientation: "horizontal",
        children: panes.map((pane) => ({ ratio: 1 / panes.length, layout: { type: "pane", pane } })),
      },
  activePaneId: panes[0]!.id,
});

function withTabs(ids: string[], activeId: string): TabsState {
  return { tabs: ids.map((id) => tab(id)), activeId };
}

const ids = (state: TabsState) => state.tabs.map((t) => t.id);
const paneIds = (state: TabsState, tabId: string) =>
  state.tabs.filter((t) => t.id === tabId).flatMap(tabPanes).map((p) => p.id);

describe("groupTabsByHost", () => {
  it("groups tabs with the same Host ID at the first member's position", () => {
    const web = host("web", "Production");
    const db = host("db", "Production");
    const first = tab("first", [remote("web.1", web), remote("web.2", web)]);
    const localTab = tab("local");
    const dbTab = tab("db", [remote("db.1", db)]);
    const sftpTab = tab("sftp", [{ kind: "sftp", id: "files", host: web }]);
    const mixed = tab("mixed", [remote("web.3", web), remote("db.2", db)]);

    expect(groupTabsByHost([first, localTab, dbTab, sftpTab, mixed])).toEqual([
      { type: "host", host: web, tabs: [first, sftpTab] },
      { type: "tab", tab: localTab },
      { type: "tab", tab: dbTab },
      { type: "tab", tab: mixed },
    ]);
  });
});

describe("tabsReducer: tabs", () => {
  it("opens a pane in a new tab at the end and focuses it", () => {
    const state = tabsReducer(withTabs(["a"], "a"), { type: "open", tabId: "b", pane: local("b.1") });
    expect(ids(state)).toEqual(["a", "b"]);
    expect(state.activeId).toBe("b");
    expect(state.tabs[1]).toEqual(tab("b", [local("b.1")]));
  });

  it("duplicates a remote Terminal in a new tab on the same Host", () => {
    const web = host("web");
    const source = tab("remote", [{ ...remote("original", web, "connected"), title: "shell title" }]);
    const state = tabsReducer({ tabs: [source], activeId: source.id }, {
      type: "duplicateTab", id: source.id, tabId: "copy", paneIds: ["new-shell"],
    });

    expect(state).toEqual({
      tabs: [source, tab("copy", [remote("new-shell", web)])],
      activeId: "copy",
    });
  });

  it("duplicates the full split and focused position of a maximized tab", () => {
    const web = host("web");
    const db = host("db");
    const source: Tab = {
      id: "work",
      layout: {
        type: "split", orientation: "horizontal", children: [
          { ratio: 0.7, layout: { type: "pane", pane: remote("web", web, "connected") } },
          { ratio: 0.3, layout: {
            type: "split", orientation: "vertical", children: [
              { ratio: 0.25, layout: { type: "pane", pane: local("local") } },
              { ratio: 0.75, layout: {
                type: "pane", pane: { ...remote("db", db, "disconnected"), restoreConnection: "manual" },
              } },
            ],
          } },
        ],
      },
      activePaneId: "db",
      paneMaximized: true,
      customTitle: "Work",
      color: "blue",
      locked: true,
    };
    const other = tab("other");
    const state = tabsReducer({ tabs: [source, other], activeId: other.id }, {
      type: "duplicateTab", id: source.id, tabId: "copy", paneIds: ["copy-web", "copy-local", "copy-db"],
    });

    expect(ids(state)).toEqual(["work", "copy", "other"]);
    expect(state.activeId).toBe("copy");
    expect(state.tabs[0]).toBe(source);
    expect(state.tabs[1]).toEqual({
      id: "copy",
      layout: {
        type: "split", orientation: "horizontal", children: [
          { ratio: 0.7, layout: { type: "pane", pane: remote("copy-web", web) } },
          { ratio: 0.3, layout: {
            type: "split", orientation: "vertical", children: [
              { ratio: 0.25, layout: { type: "pane", pane: local("copy-local") } },
              { ratio: 0.75, layout: { type: "pane", pane: remote("copy-db", db) } },
            ],
          } },
        ],
      },
      activePaneId: "copy-db",
      customTitle: "Work",
      color: "blue",
    });
  });

  it("does not duplicate tabs with a singleton pane, even in a split", () => {
    const source = tab("prefs", [{ id: "settings", kind: "settings" }, local("shell")]);
    const state = { tabs: [source], activeId: source.id };

    expect(tabsReducer(state, {
      type: "duplicateTab", id: source.id, tabId: "copy", paneIds: ["copy-settings", "copy-shell"],
    })).toBe(state);
  });

  it("opening Settings again focuses the open Settings tab instead of adding a second", () => {
    const settings = (id: string): Pane => ({ id, kind: "settings" });
    const opened = tabsReducer(withTabs(["a"], "a"), { type: "open", tabId: "s1", pane: settings("s1.1") });
    const back = tabsReducer(opened, { type: "activate", id: "a" });
    const again = tabsReducer(back, { type: "open", tabId: "s2", pane: settings("s2.1") });
    expect(ids(again)).toEqual(["a", "s1"]);
    expect(again.activeId).toBe("s1");
  });

  it("opening Home again focuses the open Home tab instead of adding a second", () => {
    const home = (id: string): Pane => ({ id, kind: "home" });
    const opened = tabsReducer(withTabs(["a"], "a"), { type: "open", tabId: "h1", pane: home("h1.1") });
    const back = tabsReducer(opened, { type: "activate", id: "a" });
    const again = tabsReducer(back, { type: "open", tabId: "h2", pane: home("h2.1") });
    expect(ids(again)).toEqual(["a", "h1"]);
    expect(again.activeId).toBe("h1");
  });

  it("does not split beside Home or SFTP", () => {
    for (const kind of ["home", "sftp"] as const) {
      const pane = kind === "home" ? ({ id: "x.1", kind } as Pane) : newPane({ kind, host: host("h") }, "x.1");
      const state: TabsState = { tabs: [tab("x", [pane])], activeId: "x" };
      expect(canSplit(state.tabs[0]!)).toBe(false);
      expect(tabsReducer(state, { type: "split", orientation: "horizontal", pane: local("x.2") })).toBe(state);
    }
    expect(canSplit(tab("a"))).toBe(true);
  });

  it("opens one Port forwards tab per Host, focusing the open one", () => {
    const forwards = (id: string, on: Host): Pane => ({ id, kind: "port-forwards", host: on });
    const [web, db] = [host("web"), host("db")];
    let state = tabsReducer(withTabs(["a"], "a"), { type: "open", tabId: "f1", pane: forwards("f1.1", web) });
    state = tabsReducer(state, { type: "open", tabId: "f2", pane: forwards("f2.1", db) });
    state = tabsReducer(state, { type: "activate", id: "a" });
    state = tabsReducer(state, { type: "open", tabId: "f3", pane: forwards("f3.1", web) });
    expect(ids(state)).toEqual(["a", "f1", "f2"]);
    expect(state.activeId).toBe("f1");
  });

  it("overrides the Host hue for just the colored tab and restores the Host hue when cleared", () => {
    const web = host("web");
    const state: TabsState = { tabs: [tab("a", [remote("a.1", web)]), tab("b", [remote("b.1", web)])], activeId: "a" };
    expect(tabHue(state.tabs[0]!)).toBe("green");

    const colored = tabsReducer(state, { type: "setTabColor", id: "a", color: "cyan" });
    expect(tabHue(colored.tabs[0]!)).toBe("cyan");
    expect(tabHue(colored.tabs[1]!)).toBe("green");

    const cleared = tabsReducer(colored, { type: "setTabColor", id: "a", color: undefined });
    expect(tabHue(cleared.tabs[0]!)).toBe("green");
  });

  it("protects a locked tab from direct, keyboard and bulk closes until it is unlocked", () => {
    const state = tabsReducer(withTabs(["a", "b", "c", "d"], "b"), { type: "setTabLocked", id: "b", locked: true });
    expect(tabsReducer(state, { type: "close", id: "b" })).toBe(state);
    expect(tabsReducer(state, { type: "closePane", paneId: "b.1" })).toBe(state);
    expect(ids(tabsReducer(state, { type: "closeOthers", id: "c" }))).toEqual(["b", "c"]);
    expect(ids(tabsReducer(state, { type: "closeRight", id: "a" }))).toEqual(["a", "b"]);

    const unlocked = tabsReducer(state, { type: "setTabLocked", id: "b", locked: false });
    expect(tabsReducer(unlocked, { type: "close", id: "b" })).toEqual(withTabs(["a", "c", "d"], "c"));
  });

  it("can close a pane in a locked split tab until only one pane remains", () => {
    const split: TabsState = { tabs: [tab("a", [local("a.1"), local("a.2")])], activeId: "a" };
    const locked = tabsReducer(split, { type: "setTabLocked", id: "a", locked: true });
    const single = tabsReducer(locked, { type: "closePane", paneId: "a.2" });
    expect(paneIds(single, "a")).toEqual(["a.1"]);
    expect(tabsReducer(single, { type: "closePane", paneId: "a.1" })).toBe(single);
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
    expect(state.tabs[0]).toMatchObject({ activePaneId: "a.2", layout: { type: "split", orientation: "vertical" } });
  });

  it("splits right and then down within the selected pane, keeping the right pane full height", () => {
    let state = tabsReducer(withTabs(["a"], "a"), { type: "split", orientation: "horizontal", pane: local("a.2") });
    state = tabsReducer(state, { type: "focusPane", paneId: "a.1" });
    state = tabsReducer(state, { type: "split", orientation: "vertical", pane: local("a.3") });
    expect(paneIds(state, "a")).toEqual(["a.1", "a.3", "a.2"]);
    expect(state.tabs[0]).toMatchObject({
      activePaneId: "a.3",
      layout: {
        type: "split",
        orientation: "horizontal",
        children: [
          {
            ratio: 0.5,
            layout: {
              type: "split",
              orientation: "vertical",
              children: [
                { ratio: 0.5, layout: { type: "pane", pane: { id: "a.1" } } },
                { ratio: 0.5, layout: { type: "pane", pane: { id: "a.3" } } },
              ],
            },
          },
          { ratio: 0.5, layout: { type: "pane", pane: { id: "a.2" } } },
        ],
      },
    });
  });

  it("does nothing when splitting with no tab open", () => {
    expect(tabsReducer(emptyTabs, { type: "split", orientation: "horizontal", pane: local("x") })).toBe(emptyTabs);
  });

  it("allows eight panes and rejects a ninth even when targeting another pane", () => {
    let state = withTabs(["a"], "a");
    for (let index = 2; index <= 8; index++) {
      state = tabsReducer(state, {
        type: "split",
        paneId: "a.1",
        orientation: index % 2 === 0 ? "horizontal" : "vertical",
        pane: local(`a.${index}`),
      });
    }
    expect(paneIds(state, "a")).toEqual(["a.1", "a.8", "a.7", "a.6", "a.5", "a.4", "a.3", "a.2"]);
    expect(canSplit(state.tabs[0]!, "a.1")).toBe(false);
    expect(tabsReducer(state, { type: "split", paneId: "a.1", orientation: "horizontal", pane: local("a.9") })).toBe(state);
  });

  it("promotes the remaining sibling after closing a nested split", () => {
    let state = withTabs(["a"], "a");
    state = tabsReducer(state, { type: "split", orientation: "horizontal", pane: local("a.2") });
    const before = state.tabs[0]?.layout;
    state = tabsReducer(state, { type: "split", orientation: "vertical", pane: local("a.3") });
    state = tabsReducer(state, { type: "closePane", paneId: "a.3" });
    expect(state.tabs[0]?.layout).toEqual(before);
    expect(state.tabs[0]?.activePaneId).toBe("a.2");
    state = tabsReducer(state, { type: "closePane", paneId: "a.2" });
    expect(state).toEqual(withTabs(["a"], "a"));
  });

  it("focusing a pane also brings its tab to the front", () => {
    const state: TabsState = { tabs: [tab("a"), tab("b", [local("b.1"), local("b.2")])], activeId: "a" };
    const next = tabsReducer(state, { type: "focusPane", paneId: "b.2" });
    expect(next.activeId).toBe("b");
    expect(next.tabs[1]?.activePaneId).toBe("b.2");
    expect(tabsReducer(state, { type: "focusPane", paneId: "zzz" })).toBe(state);
  });

  it("temporarily maximizes the focused pane and restores the original split", () => {
    const state = tabsReducer(withTabs(["a"], "a"), { type: "split", orientation: "horizontal", pane: local("a.2") });
    const maximized = tabsReducer(state, { type: "toggleMaximizePane" });
    expect(maximized.tabs[0]).toMatchObject({ activePaneId: "a.2", paneMaximized: true });
    expect(maximized.tabs[0]?.layout).toBe(state.tabs[0]?.layout);
    expect(tabsReducer(maximized, { type: "toggleMaximizePane" })).toEqual(state);
  });

  it.each([
    { type: "split", orientation: "vertical", pane: local("a.4") },
    { type: "closePane", paneId: "a.3" },
    { type: "closePane", paneId: "a.1" },
    { type: "focusPane", paneId: "a.1" },
    { type: "cyclePane", step: 1 },
  ] as const)("restores the layout when changing panes with $type", (action) => {
    let state = withTabs(["a"], "a");
    state = tabsReducer(state, { type: "split", orientation: "horizontal", pane: local("a.2") });
    state = tabsReducer(state, { type: "split", orientation: "vertical", pane: local("a.3") });
    const maximized = tabsReducer(state, { type: "toggleMaximizePane" });
    expect(tabsReducer(maximized, action)).toEqual(tabsReducer(state, action));
  });

  it("ignores maximize when only one pane is open", () => {
    const state = withTabs(["a"], "a");
    expect(tabsReducer(state, { type: "toggleMaximizePane" })).toBe(state);
  });

  it("cycles focus through the active tab's panes", () => {
    let state = withTabs(["a"], "a");
    state = tabsReducer(state, { type: "split", orientation: "horizontal", pane: local("a.2") });
    state = tabsReducer(state, { type: "split", paneId: "a.1", orientation: "vertical", pane: local("a.3") });
    expect(tabsReducer(state, { type: "cyclePane", step: 1 }).tabs[0]?.activePaneId).toBe("a.2");
    expect(tabsReducer(state, { type: "cyclePane", step: -1 }).tabs[0]?.activePaneId).toBe("a.1");
    state = tabsReducer(state, { type: "cyclePane", step: 1 });
    expect(tabsReducer(state, { type: "cyclePane", step: 1 }).tabs[0]?.activePaneId).toBe("a.1");
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

describe("tabsReducer: pane swaps", () => {
  function nestedSplit(): TabsState {
    let state = withTabs(["a"], "a");
    state = tabsReducer(state, { type: "split", orientation: "horizontal", pane: local("a.2") });
    state = tabsReducer(state, { type: "split", orientation: "vertical", pane: local("a.3") });
    return tabsReducer(state, { type: "resizeSplit", tabId: "a", path: [1], after: 0, fraction: 0.25 });
  }

  it("swaps right with the pane sharing the most edge in a nested split, keeping focus and proportions", () => {
    const state = tabsReducer(nestedSplit(), { type: "focusPane", paneId: "a.1" });
    const swapped = tabsReducer(state, { type: "swapPane", direction: "right" });
    expect(paneIds(swapped, "a")).toEqual(["a.3", "a.2", "a.1"]);
    expect(swapped.tabs[0]).toMatchObject({
      activePaneId: "a.1",
      layout: {
        orientation: "horizontal",
        children: [
          { ratio: 0.5 },
          {
            ratio: 0.5,
            layout: {
              orientation: "vertical",
              children: [{ ratio: 0.25 }, { ratio: 0.75 }],
            },
          },
        ],
      },
    });
  });

  it.each([
    { paneId: "a.2", direction: "left", order: ["a.2", "a.1", "a.3"] },
    { paneId: "a.2", direction: "down", order: ["a.1", "a.3", "a.2"] },
    { paneId: "a.3", direction: "up", order: ["a.1", "a.3", "a.2"] },
  ] as const)("swaps $direction and keeps the same Terminal focused", ({ paneId, direction, order }) => {
    const state = tabsReducer(nestedSplit(), { type: "focusPane", paneId });
    const swapped = tabsReducer(state, { type: "swapPane", direction });
    expect(paneIds(swapped, "a")).toEqual(order);
    expect(swapped.tabs[0]?.activePaneId).toBe(paneId);
  });

  it.each([
    { paneId: "a.1", direction: "left" },
    { paneId: "a.3", direction: "right" },
    { paneId: "a.2", direction: "up" },
    { paneId: "a.3", direction: "down" },
  ] as const)("ignores swaps $direction at the edge of the tab", ({ paneId, direction }) => {
    const state = tabsReducer(nestedSplit(), { type: "focusPane", paneId });
    expect(tabsReducer(state, { type: "swapPane", direction })).toBe(state);
  });
});

describe("tabsReducer: pane state", () => {
  it("retitles a pane when its shell sets a title, and clears it on an empty title", () => {
    const titled = tabsReducer(withTabs(["a", "b"], "a"), { type: "retitle", paneId: "b.1", title: "vim notes.md" });
    expect(activePane(titled.tabs[1]!)).toEqual({ id: "b.1", kind: "local-terminal", title: "vim notes.md" });
    const cleared = tabsReducer(titled, { type: "retitle", paneId: "b.1", title: "  " });
    expect(activePane(cleared.tabs[1]!).title).toBeUndefined();
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

describe("reconnectingHosts", () => {
  it("lists each Host whose Terminal is retrying its Connection once, with how far the retries are", () => {
    const web = host("web", "web-1");
    const db = host("db", "db-1");
    let state: TabsState = {
      tabs: [
        tab("a", [remote("a.1", web, "connected"), remote("a.2", web, "connected")]),
        tab("b", [remote("b.1", db, "connected")]),
      ],
      activeId: "a",
    };
    expect(reconnectingHosts(state)).toEqual([]);

    state = tabsReducer(state, { type: "status", paneId: "a.1", status: "connecting", reconnecting: { attempt: 1, attempts: 3 } });
    state = tabsReducer(state, { type: "status", paneId: "a.2", status: "connecting", reconnecting: { attempt: 2, attempts: 3 } });
    expect(reconnectingHosts(state)).toEqual([{ host: web, attempt: 2, attempts: 3 }]);

    // Back up: no longer listed.
    state = tabsReducer(state, { type: "status", paneId: "a.1", status: "connected" });
    state = tabsReducer(state, { type: "status", paneId: "a.2", status: "connected" });
    expect(reconnectingHosts(state)).toEqual([]);
  });

  it("drops a Host once its retries give up", () => {
    const web = host("web", "web-1");
    let state: TabsState = { tabs: [tab("a", [remote("a.1", web, "connected")])], activeId: "a" };
    state = tabsReducer(state, { type: "status", paneId: "a.1", status: "connecting", reconnecting: { attempt: 3, attempts: 3 } });
    state = tabsReducer(state, { type: "status", paneId: "a.1", status: "disconnected" });
    expect(reconnectingHosts(state)).toEqual([]);
  });
});

describe("tabTitle", () => {
  const names = { "tabs.home": "Home", "tabs.localTerminal": "Local terminal", "tabs.settings": "Settings", "tabs.portForwards": "Port forwards", "tabs.sftp": "SFTP", "quickConnect.temporaryHost": "Temporary Host", "transfers.title": "Transfers" };
  const t = (key: keyof typeof names) => names[key];

  it("names the Home tab", () => {
    expect(tabTitle(tab("h", [{ id: "h.1", kind: "home" }]), t, 1)).toBe("Home");
  });

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

  it("can show Host names without losing existing shell titles or overriding a custom name", () => {
    let state: TabsState = {
      tabs: [tab("a", [remote("a.1", host("web", "web-1")), { ...local("a.2"), title: "htop" }])],
      activeId: "a",
    };
    state = tabsReducer(state, { type: "retitle", paneId: "a.1", title: "Deploy shell" });
    expect(tabTitle(state.tabs[0]!, t, 1, "host")).toBe("web-1");
    expect(tabTitle(state.tabs[0]!, t, 1, "shell")).toBe("Deploy shell");

    state = tabsReducer(state, { type: "focusPane", paneId: "a.2" });
    expect(tabTitle(state.tabs[0]!, t, 2, "host")).toBe("Local terminal 2");
    state = tabsReducer(state, { type: "renameTab", id: "a", title: "Operations" });
    expect(tabTitle(state.tabs[0]!, t, 2, "host")).toBe("Operations");
  });

  it("keeps a custom title while pane focus and shell titles change, then restores the current automatic title", () => {
    let state: TabsState = { tabs: [tab("a", [local("a.1"), local("a.2")])], activeId: "a" };
    state = tabsReducer(state, { type: "renameTab", id: "a", title: "  Deploy  " });
    state = tabsReducer(state, { type: "focusPane", paneId: "a.2" });
    state = tabsReducer(state, { type: "retitle", paneId: "a.2", title: "vim notes.md" });
    expect(tabTitle(state.tabs[0]!, t, 1)).toBe("Deploy");

    state = tabsReducer(state, { type: "renameTab", id: "a", title: "  " });
    expect(tabTitle(state.tabs[0]!, t, 1)).toBe("vim notes.md");
  });

  it("names a Port forwards tab after its Host", () => {
    expect(tabTitle(tab("f", [{ id: "f.1", kind: "port-forwards", host: host("h", "web-1") }]), t, 1)).toBe(
      "Port forwards · web-1",
    );
  });

  it("reuses the standalone SFTP tab for a Host and keeps it separate from its Terminal", () => {
    const web = host("web", "web-1");
    const terminal = remote("r.1", web, "connected");
    const files = newPane({ kind: "sftp", host: web }, "f.1");
    let state = tabsReducer(emptyTabs, { type: "open", tabId: "terminal", pane: terminal });
    state = tabsReducer(state, { type: "open", tabId: "files", pane: files });
    state = tabsReducer(state, { type: "activate", id: "terminal" });
    state = tabsReducer(state, { type: "open", tabId: "duplicate", pane: newPane({ kind: "sftp", host: web }) });
    expect(state.tabs.map(({ id }) => id)).toEqual(["terminal", "files"]);
    expect(state.activeId).toBe("files");
    expect(tabTitle(state.tabs[1]!, t, 1)).toBe("SFTP · web-1");
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

describe("startupTabs", () => {
  it("opens with the Home tab and no Terminal", () => {
    const state = startupTabs();
    expect(state.tabs).toHaveLength(1);
    expect(activePane(state.tabs[0]!).kind).toBe("home");
    expect(state.activeId).toBe(state.tabs[0]!.id);
  });
});
