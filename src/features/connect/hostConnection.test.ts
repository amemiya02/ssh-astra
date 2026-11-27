import { describe, expect, it } from "vitest";
import { newPane, tabsReducer, emptyTabs, type PaneKind, type TabsState } from "@/features/workspace/tabs";
import type { Host } from "@/lib/ipc/hosts";
import { hostConnections } from "./hostConnection";

const host = (id: string) => ({ id, name: id, address: `${id}.test`, user: "me", port: 22 }) as Host;
const [a, b] = [host("a"), host("b")] as const;

function open(...kinds: PaneKind[]): TabsState {
  return kinds.reduce((state, kind, i) => tabsReducer(state, { type: "open", tabId: `t${i}`, pane: newPane(kind, `p${i}`) }), emptyTabs);
}

describe("hostConnections", () => {
  it("has no entry for a Host with no Connection", () => {
    expect(hostConnections([], open({ kind: "home" }), []).size).toBe(0);
  });

  it("marks live Connections connected", () => {
    expect([...hostConnections([a, b], open({ kind: "home" }), [])]).toEqual([
      ["a", "connected"],
      ["b", "connected"],
    ]);
  });

  it("marks a Host a Terminal is opening, or Connect only is reaching, as connecting", () => {
    const states = hostConnections([], open({ kind: "remote-terminal", host: a }), ["c"]);
    expect(states.get("a")).toBe("connecting");
    expect(states.get("c")).toBe("connecting");
  });

  it("keeps a connected Host connected while another Terminal opens to it", () => {
    const states = hostConnections([a], open({ kind: "remote-terminal", host: a }), []);
    expect(states.get("a")).toBe("connected");
  });

  it("shows a Terminal retrying a dropped Connection as connecting", () => {
    const state = tabsReducer(open({ kind: "remote-terminal", host: a }), {
      type: "status",
      paneId: "p0",
      status: "connecting",
      reconnecting: { attempt: 1, attempts: 3 },
    });
    expect(hostConnections([a], state, []).get("a")).toBe("connecting");
  });

  it("says nothing about a Host whose Terminal disconnected", () => {
    const state = tabsReducer(open({ kind: "remote-terminal", host: b }), { type: "status", paneId: "p0", status: "disconnected" });
    expect(hostConnections([], state, []).has("b")).toBe(false);
  });
});
