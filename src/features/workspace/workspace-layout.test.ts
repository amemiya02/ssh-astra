import { describe, expect, it, vi } from "vitest";
import { openSettings } from "@/lib/storage";
import type { Host } from "@/lib/ipc/hosts";
import { emptyTabs, newPane, nextRestoreConnection, tabPanes, tabsReducer } from "./tabs";
import { restoreWorkspaceLayout, serializeWorkspaceLayout, workspaceLayoutSetting } from "./workspace-layout";
import { workspaceSetting } from "./workspace-prefs";

const local = (id: string) => newPane({ kind: "local-terminal" }, id);
const pane = (id: string) => ({ type: "pane", pane: local(id) });

describe("workspace layout storage", () => {
  it("repairs a flat layout into a split tree with the same pane order, proportions and focus", () => {
    const raw = {
      activeId: "work",
      tabs: [{
        id: "work",
        orientation: "vertical",
        panes: [local("a"), local("b"), local("c")],
        ratios: [20, 30, 50],
        activePaneId: "b",
      }],
    };
    expect(workspaceLayoutSetting.parse(raw)).toEqual({
      activeId: "work",
      tabs: [{
        id: "work",
        activePaneId: "b",
        layout: {
          type: "split",
          orientation: "vertical",
          children: [
            { ratio: 0.2, layout: pane("a") },
            { ratio: 0.3, layout: pane("b") },
            { ratio: 0.5, layout: pane("c") },
          ],
        },
      }],
    });
  });

  it("gives equal shares to panes from the original flat format without saved proportions", () => {
    const tabs = [{ id: "work", orientation: "horizontal", activePaneId: "a", panes: [local("a"), local("b")] }];
    expect(workspaceLayoutSetting.parse({ tabs, activeId: "work" }).tabs[0]?.layout).toEqual({
      type: "split",
      orientation: "horizontal",
      children: [{ ratio: 0.5, layout: pane("a") }, { ratio: 0.5, layout: pane("b") }],
    });
  });

  it("drops invalid panes, collapses damaged branches, and repairs invalid proportions and focus", () => {
    const raw = {
      activeId: "gone",
      tabs: [null, {
        id: "work",
        activePaneId: "gone",
        layout: {
          type: "split",
          orientation: "invalid",
          children: [
            { ratio: -2, layout: pane("a") },
            { ratio: Infinity, layout: { type: "split", children: [null, { ratio: 10, layout: pane("b") }] } },
            { ratio: 0.2, layout: { type: "pane", pane: { id: "gone", kind: "remote-terminal" } } },
            { ratio: 0.8, layout: pane("a") },
          ],
        },
      }],
    };
    expect(workspaceLayoutSetting.parse(raw)).toEqual({
      activeId: "work",
      tabs: [{
        id: "work",
        activePaneId: "a",
        layout: {
          type: "split",
          orientation: "horizontal",
          children: [{ ratio: 0.5, layout: pane("a") }, { ratio: 0.5, layout: pane("b") }],
        },
      }],
    });
  });

  it("saves and loads the new proportion of a nested split", async () => {
    let state = tabsReducer(emptyTabs, { type: "open", tabId: "work", pane: local("a") });
    state = tabsReducer(state, { type: "split", orientation: "horizontal", pane: local("b") });
    state = tabsReducer(state, { type: "split", orientation: "vertical", pane: local("c") });
    state = tabsReducer(state, { type: "resizeSplit", tabId: "work", path: [1], after: 0, fraction: 0.75 });

    let saved: Record<string, unknown> = {};
    const backend = {
      load: () => Promise.resolve(saved),
      save: vi.fn((section: string, value: unknown) => {
        saved = JSON.parse(JSON.stringify({ [section]: value })) as Record<string, unknown>;
        return Promise.resolve();
      }),
    };
    const settings = await openSettings(backend);
    settings.set(workspaceLayoutSetting, serializeWorkspaceLayout(state));
    const reopened = await openSettings(backend);
    expect(reopened.get(workspaceLayoutSetting).tabs[0]?.layout).toEqual({
      type: "split",
      orientation: "horizontal",
      children: [
        { ratio: 0.5, layout: pane("a") },
        { ratio: 0.5, layout: {
          type: "split",
          orientation: "vertical",
          children: [{ ratio: 0.75, layout: pane("b") }, { ratio: 0.25, layout: pane("c") }],
        } },
      ],
    });
  });

  it("records a remote pane's Host id without the Host or its live Terminal state", () => {
    const host: Host = {
      id: "remote",
      name: "Remote",
      address: "remote.example",
      port: 22,
      user: "operator",
      auth: { type: "password" },
      jumpHost: null,
      groupId: null,
      forwards: [],
    };
    const remote = newPane({ kind: "remote-terminal", host }, "a");
    const state = tabsReducer(emptyTabs, {
      type: "open",
      tabId: "work",
      pane: { ...remote, status: "connected", title: "Editor" },
    });
    expect(serializeWorkspaceLayout(state).tabs[0]?.layout).toEqual({
      type: "pane",
      pane: { id: "a", kind: "remote-terminal", hostId: "remote" },
    });
  });
});

const host: Host = {
  id: "kept",
  name: "Current name",
  address: "current.example",
  port: 22,
  user: "operator",
  auth: { type: "password" },
  jumpHost: null,
  groupId: null,
  forwards: [],
};

const remote = (id: string, hostId: string) => ({ type: "pane", pane: { id, kind: "remote-terminal", hostId } });

describe("workspace startup", () => {
  it("restores the saved tree and customization, rehydrates current Hosts, and removes panes for deleted Hosts", () => {
    const raw = {
      activeId: "removed",
      tabs: [
        { id: "removed", layout: remote("missing", "deleted"), locked: true },
        {
          id: "work",
          activePaneId: "gone",
          customTitle: "  Ops  ",
          color: "green",
          locked: true,
          layout: {
            type: "split",
            orientation: "vertical",
            children: [
              { ratio: 0.1875, layout: {
                type: "split",
                orientation: "horizontal",
                children: [
                  { ratio: 0.5, layout: remote("live", "kept") },
                  { ratio: 0.5, layout: remote("gone-inner", "deleted") },
                ],
              } },
              { ratio: 0.5, layout: remote("gone", "deleted") },
              { ratio: 0.3125, layout: pane("local") },
            ],
          },
        },
      ],
    };
    const saved = workspaceLayoutSetting.parse(raw);
    const state = restoreWorkspaceLayout(saved, [host], "layout");

    expect(nextRestoreConnection(state.tabs)).toBeUndefined();
    expect(state.activeId).toBe("work");
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      id: "work", activePaneId: "live", customTitle: "Ops", color: "green", locked: true,
    });
    expect(tabPanes(state.tabs[0]!)).toEqual([
      { id: "live", kind: "remote-terminal", host, status: "disconnected", restoreConnection: "manual" },
      local("local"),
    ]);
    expect(serializeWorkspaceLayout(state)).toEqual({
      activeId: "work",
      tabs: [{
        id: "work",
        activePaneId: "live",
        customTitle: "Ops",
        color: "green",
        locked: true,
        layout: {
          type: "split",
          orientation: "vertical",
          children: [
            { ratio: 0.375, layout: remote("live", "kept") },
            { ratio: 0.625, layout: pane("local") },
          ],
        },
      }],
    });
  });

  it("advances automatic reconnections after success, failure, or closure without changing focus", () => {
    const saved = workspaceLayoutSetting.parse({
      activeId: "home",
      tabs: [
        { id: "first-tab", layout: remote("first", "kept") },
        { id: "second-tab", layout: remote("second", "kept") },
        { id: "third-tab", layout: remote("third", "kept") },
        { id: "home", layout: { type: "pane", pane: { id: "home-pane", kind: "home" } } },
      ],
    });
    let state = restoreWorkspaceLayout(saved, [host], "connect");
    expect(nextRestoreConnection(state.tabs)).toBe("first");
    state = tabsReducer(state, { type: "move", id: "third-tab", to: 0 });
    state = tabsReducer(state, { type: "status", paneId: "first", status: "connecting" });
    expect(nextRestoreConnection(state.tabs)).toBe("first");
    state = tabsReducer(state, { type: "status", paneId: "first", status: "connected" });
    expect(nextRestoreConnection(state.tabs)).toBe("second");
    state = tabsReducer(state, { type: "status", paneId: "second", status: "disconnected" });
    expect(nextRestoreConnection(state.tabs)).toBe("third");
    state = tabsReducer(state, { type: "close", id: "third-tab" });
    expect(nextRestoreConnection(state.tabs)).toBeUndefined();
    expect(state.activeId).toBe("home");
  });

  it("starts on Home with restoration disabled and when no saved pane survives", () => {
    const saved = workspaceLayoutSetting.parse({
      activeId: "work",
      tabs: [{ id: "work", activePaneId: "remote", layout: remote("remote", "kept") }],
    });
    for (const state of [restoreWorkspaceLayout(saved, [host], "none"), restoreWorkspaceLayout(saved, [], "layout")]) {
      expect(state.activeId).toBe(state.tabs[0]?.id);
      expect(state.tabs).toHaveLength(1);
      expect(tabPanes(state.tabs[0]!).map(({ kind }) => kind)).toEqual(["home"]);
    }
  });

  it("defaults to layout-only restoration and repairs unknown options", () => {
    expect(workspaceSetting.parse(undefined)).toEqual({ restoreTabs: "layout" });
    expect(workspaceSetting.parse({ restoreTabs: "unknown" })).toEqual({ restoreTabs: "layout" });
    expect(workspaceSetting.parse({ restoreTabs: "connect" })).toEqual({ restoreTabs: "connect" });
    expect(workspaceSetting.parse({ restoreTabs: "none" })).toEqual({ restoreTabs: "none" });
  });
});
