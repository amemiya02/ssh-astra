import { describe, expect, it } from "vitest";
import { emptyTabs, tabsReducer, tabTitle, type TabsState } from "./tabs";

const local = (id: string) => ({ id, kind: "local-terminal" as const });

function withTabs(ids: string[], activeId: string): TabsState {
  return { tabs: ids.map(local), activeId };
}

describe("tabsReducer", () => {
  it("opens a tab at the end and focuses it", () => {
    const state = tabsReducer(withTabs(["a"], "a"), { type: "open", tab: local("b") });
    expect(state.tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(state.activeId).toBe("b");
  });

  it("opening Settings again focuses the open Settings tab instead of adding a second", () => {
    const opened = tabsReducer(withTabs(["a"], "a"), { type: "open", tab: { id: "s1", kind: "settings" } });
    const back = tabsReducer(opened, { type: "activate", id: "a" });
    const again = tabsReducer(back, { type: "open", tab: { id: "s2", kind: "settings" } });
    expect(again.tabs.map((t) => t.id)).toEqual(["a", "s1"]);
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

  it("retitles a tab when its shell sets a title, and clears it on an empty title", () => {
    const titled = tabsReducer(withTabs(["a", "b"], "a"), { type: "retitle", id: "b", title: "vim notes.md" });
    expect(titled.tabs[1]).toEqual({ id: "b", kind: "local-terminal", title: "vim notes.md" });
    const cleared = tabsReducer(titled, { type: "retitle", id: "b", title: "  " });
    expect(cleared.tabs[1]?.title).toBeUndefined();
  });

  it("does nothing when cycling with no tabs", () => {
    expect(tabsReducer(emptyTabs, { type: "cycle", step: 1 })).toBe(emptyTabs);
  });
});

describe("tabTitle", () => {
  const t = (key: "tabs.localTerminal" | "tabs.settings") => (key === "tabs.settings" ? "Settings" : "Local terminal");

  it("names the Settings tab", () => {
    expect(tabTitle({ id: "s", kind: "settings" }, t, 1)).toBe("Settings");
  });

  it("numbers Local terminals after the first so tabs stay distinguishable", () => {
    expect(tabTitle(local("a"), t, 1)).toBe("Local terminal");
    expect(tabTitle(local("b"), t, 2)).toBe("Local terminal 2");
  });

  it("prefers the title the shell set", () => {
    expect(tabTitle({ ...local("a"), title: "htop" }, t, 2)).toBe("htop");
  });

  it("names a remote Terminal after its Host", () => {
    const host = { id: "h", name: "web-1", address: "10.0.0.5", port: 22, user: "deploy", auth: { type: "password" as const }, jumpHost: null };
    expect(tabTitle({ id: "r", kind: "remote-terminal", host }, t, 1)).toBe("web-1");
  });
});

describe("emptyTabs", () => {
  it("has no tabs and nothing active", () => {
    expect(emptyTabs).toEqual({ tabs: [], activeId: null });
  });
});
