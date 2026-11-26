import { describe, expect, it, vi } from "vitest";
import type { HeldEvent } from "@/lib/ipc/connections";
import { createConnectionsStore, type ConnectionsApi } from "./connectionsStore";

function fakeApi(overrides: Partial<ConnectionsApi> = {}) {
  let push: (event: HeldEvent) => void = () => {};
  const api: ConnectionsApi = {
    watchConnections: vi.fn((onEvent: (event: HeldEvent) => void) => {
      push = onEvent;
      return Promise.resolve(["h1"]);
    }),
    connectHost: vi.fn(() => Promise.resolve()),
    disconnectHost: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  return { api, push: (event: HeldEvent) => push(event) };
}

const ask = () => Promise.reject(new Error("no prompts in this test"));

describe("connections store", () => {
  it("starts from the backend's held Hosts and follows its changes", async () => {
    const { api, push } = fakeApi();
    const store = createConnectionsStore(api);
    await store.getState().watch();
    expect(store.getState().held).toEqual(["h1"]);

    push({ hostId: "h2", held: true });
    push({ hostId: "h1", held: false });
    push({ hostId: "h2", held: true });

    expect(store.getState().held).toEqual(["h2"]);
  });

  it("replaces the held Hosts and ignores late events from the old channel", async () => {
    const channels: Array<(event: HeldEvent) => void> = [];
    const { api } = fakeApi({
      watchConnections: async receive => {
        channels.push(receive);
        if (channels.length === 1) return ["old"];
        receive({ hostId: "released", held: false });
        return ["new", "released"];
      },
    });
    const store = createConnectionsStore(api);
    await store.getState().watch();
    await Promise.all([store.getState().watch(), store.getState().watch()]);
    expect(channels).toHaveLength(2);
    channels[0]!({ hostId: "old", held: true });
    channels[1]!({ hostId: "live", held: true });
    expect(store.getState().held).toEqual(["new", "live"]);
  });

  it("drops buffered events from a failed registration and can register again", async () => {
    const { api } = fakeApi();
    let abandoned!: (event: HeldEvent) => void;
    vi.mocked(api.watchConnections).mockImplementationOnce(async receive => {
      abandoned = receive;
      receive({ hostId: "early", held: true });
      throw new Error("watch failed");
    });
    const store = createConnectionsStore(api);
    await expect(store.getState().watch()).rejects.toThrow("watch failed");
    await store.getState().watch();
    abandoned({ hostId: "late", held: true });
    expect(store.getState().held).toEqual(["h1"]);
  });

  it("connects only, passing questions through, and marks the Host as connecting meanwhile", async () => {
    let finish = () => {};
    const connectHost = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { api } = fakeApi({ connectHost });
    const store = createConnectionsStore(api);

    const done = store.getState().connect("h3", ask);
    expect(store.getState().connecting).toEqual(["h3"]);
    expect(connectHost).toHaveBeenCalledWith("h3", ask);
    finish();
    await done;

    expect(store.getState().connecting).toEqual([]);
  });

  it("rejects with the CommandError when connecting fails", async () => {
    const { api } = fakeApi({
      connectHost: vi.fn(() => Promise.reject({ kind: "authenticationFailed", message: "nope" })),
    });
    const store = createConnectionsStore(api);

    await expect(store.getState().connect("h3", ask)).rejects.toEqual({ kind: "authenticationFailed", message: "nope" });
    expect(store.getState().connecting).toEqual([]);
  });

  it("disconnects and forgets the Host at once", async () => {
    const { api } = fakeApi();
    const store = createConnectionsStore(api);
    await store.getState().watch();

    await store.getState().disconnect("h1");

    expect(api.disconnectHost).toHaveBeenCalledWith("h1");
    expect(store.getState().held).toEqual([]);
  });
});
