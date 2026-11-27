import { describe, expect, it, vi } from "vitest";
import type { ForwardEvent } from "@/lib/ipc/forwards";
import { createForwardsStore, runningForwards, statusOf, type ForwardsApi } from "./forwardsStore";

const running = (forwardId: string, hostId = "h1"): ForwardEvent => ({
  hostId,
  forwardId,
  status: { state: "running" },
});

function fakeApi(overrides: Partial<ForwardsApi> = {}) {
  let push: (event: ForwardEvent) => void = () => {};
  const api: ForwardsApi = {
    watchForwards: vi.fn((onEvent: (event: ForwardEvent) => void) => {
      push = onEvent;
      return Promise.resolve([running("a")]);
    }),
    startForward: vi.fn(() => Promise.resolve()),
    stopForward: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  return { api, push: (event: ForwardEvent) => push(event) };
}

const ask = () => Promise.reject(new Error("no prompts in this test"));

describe("forwards store", () => {
  it("starts from the backend's list and follows its state changes", async () => {
    const { api, push } = fakeApi();
    const failures: string[] = [];
    const store = createForwardsStore(api, (failure) => failures.push(failure));
    await store.getState().watch();
    expect(statusOf(store.getState(), "a")).toEqual({ state: "running" });

    push({ hostId: "h1", forwardId: "b", status: { state: "failed", reason: "port 80 on 127.0.0.1 is already in use" } });
    push({ hostId: "h1", forwardId: "a", status: { state: "stopped" } });

    expect(statusOf(store.getState(), "a")).toEqual({ state: "stopped" });
    expect(statusOf(store.getState(), "b")).toEqual({
      state: "failed",
      reason: "port 80 on 127.0.0.1 is already in use",
    });
    expect(statusOf(store.getState(), "never-started")).toEqual({ state: "stopped" });
    expect(failures).toEqual(["port 80 on 127.0.0.1 is already in use"]);
  });

  it("keeps a rule stopped when its event arrives before an older running snapshot", async () => {
    const { api } = fakeApi({
      watchForwards: async (receive) => {
        receive({ ...running("a"), status: { state: "stopped" } });
        return [running("a")];
      },
    });
    const store = createForwardsStore(api);
    await store.getState().watch();
    expect(runningForwards(store.getState())).toEqual([]);
  });

  it("lists the running forwards for the status bar", async () => {
    const { api, push } = fakeApi();
    const store = createForwardsStore(api);
    await store.getState().watch();
    push(running("c", "h2"));
    push({ hostId: "h1", forwardId: "d", status: { state: "failed", reason: "x" } });

    expect(runningForwards(store.getState()).map((e) => e.forwardId)).toEqual(["a", "c"]);
  });

  it("shows a failed connect as the rule's error, and stop clears it", async () => {
    const { api } = fakeApi({
      startForward: vi.fn(() => Promise.reject({ kind: "authenticationFailed", message: "authentication failed" })),
    });
    const store = createForwardsStore(api);
    await store.getState().watch();

    await expect(store.getState().start("h1", "e", ask)).rejects.toMatchObject({ kind: "authenticationFailed" });
    expect(statusOf(store.getState(), "e")).toEqual({ state: "failed", reason: "authentication failed" });

    await store.getState().stop("e");
    expect(api.stopForward).toHaveBeenCalledWith("e");
    expect(statusOf(store.getState(), "e")).toEqual({ state: "stopped" });
  });

  it("reports each failed start once when the backend event follows its command error", async () => {
    const reason = "port 80 on 127.0.0.1 is already in use";
    const { api, push } = fakeApi({
      startForward: async () => { throw { kind: "portInUse", message: reason }; },
    });
    const failures: string[] = [];
    const store = createForwardsStore(api, (failure) => failures.push(failure));
    await store.getState().watch();

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(store.getState().start("h1", "a", ask)).rejects.toMatchObject({ kind: "portInUse" });
      push({ ...running("a"), status: { state: "failed", reason } });
    }
    expect(failures).toEqual([reason, reason]);
  });

  it("does not record a cancelled connect as an error", async () => {
    const { api } = fakeApi({
      startForward: vi.fn(() => Promise.reject({ kind: "cancelled", message: "cancelled" })),
    });
    const store = createForwardsStore(api);

    await expect(store.getState().start("h1", "e", ask)).rejects.toMatchObject({ kind: "cancelled" });
    expect(statusOf(store.getState(), "e")).toEqual({ state: "stopped" });
  });
});
