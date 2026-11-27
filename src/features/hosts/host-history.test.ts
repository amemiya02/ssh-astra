import { describe, expect, it } from "vitest";
import { noteConnections, noteOpened, recentHostIds, recentHostsSetting } from "./host-history";

describe("noteOpened", () => {
  it("moves the opened Host to the front without repeating it", () => {
    const history = recentHostsSetting.parse(["b", "a", "c"]);
    expect(recentHostIds(noteOpened(history, "a", 100))).toEqual(["a", "b", "c"]);
    expect(recentHostIds(noteOpened({}, "a", 100))).toEqual(["a"]);
  });

  it("lists only the most recent Hosts, even when opens share a millisecond", () => {
    const history = Array.from({ length: 30 }, (_, i) => `h${i}`).reduce((visits, id) => noteOpened(visits, id, 100), {});
    const ids = recentHostIds(history);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe("h29");
    expect(ids[19]).toBe("h10");
  });
});

describe("recentHostsSetting", () => {
  it("repairs whatever the settings file holds", () => {
    expect(recentHostsSetting.parse(undefined)).toEqual({});
    expect(recentHostsSetting.parse("nope")).toEqual({});
    expect(recentHostsSetting.parse(["a", 3, "b", "a", null])).toEqual({
      a: { openedAt: -1, connectedAt: -1 },
      b: { openedAt: -2, connectedAt: -2 },
    });
    expect(recentHostsSetting.parse({ a: { openedAt: 50 }, b: { connectedAt: 75 }, c: { connectedAt: "yesterday" } })).toEqual({
      a: { openedAt: 50 },
      b: { connectedAt: 75 },
    });
  });
});

describe("noteConnections", () => {
  it("records newly connected Hosts without changing the recent-open order", () => {
    const opened = noteOpened(recentHostsSetting.parse(["legacy"]), "failed", 100);
    const connecting = new Map([["failed", "connecting"]] as const);
    const connected = new Map([["connected", "connected"]] as const);

    expect(noteConnections(opened, new Map(), connecting, 101)).toBe(opened);
    const history = noteConnections(opened, connecting, connected, 102);
    expect(history.failed).toEqual({ openedAt: 100 });
    expect(history.connected).toEqual({ connectedAt: 102 });
    expect(recentHostIds(history)).toEqual(["failed", "legacy"]);
    expect(noteConnections(history, connected, new Map(connected), 103)).toBe(history);
  });
});
