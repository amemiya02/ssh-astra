import { describe, expect, it, vi } from "vitest";
import { openSettings } from "@/lib/storage";
import type { Host } from "@/lib/ipc/hosts";
import { emptyTabs, newPane, tabsReducer } from "./tabs";
import { serializeWorkspaceLayout, workspaceLayoutSetting } from "./workspace-layout";

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
