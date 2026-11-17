import { describe, expect, it } from "vitest";
import { emptyTabs, tabsReducer, type TabsState } from "./tabs";

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
});

describe("emptyTabs", () => {
  it("has no tabs and nothing active", () => {
    expect(emptyTabs).toEqual({ tabs: [], activeId: null });
  });
});
