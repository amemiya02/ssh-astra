import { describe, expect, it, vi } from "vitest";
import type { Transfer } from "@/lib/ipc/transfers";
import {
  activeTransfers,
  createTransfersStore,
  doneTransfers,
  firstConflict,
  formatDuration,
  timeLeft,
  transferGroups,
  transferSummary,
  type TransfersApi,
} from "./transfersStore";

const transfer = (id: number, patch: Partial<Transfer> = {}): Transfer => ({
  id,
  direction: "upload",
  name: `file-${id}`,
  source: `/local/file-${id}`,
  target: `/remote/file-${id}`,
  state: { type: "running" },
  bytesDone: 0,
  bytesTotal: 1000,
  filesDone: 0,
  unprotected: false,
  filesTotal: 1,
  ...patch,
});

function setup(initial: Transfer[] = []) {
  let push: (t: Transfer) => void = () => {};
  const api: TransfersApi = {
    watchTransfers: vi.fn((onEvent: (t: Transfer) => void) => {
      push = onEvent;
      return Promise.resolve(initial);
    }),
    uploadFiles: vi.fn(() => Promise.resolve([1])),
    copyRemoteFiles: vi.fn(async () => []),
    downloadFiles: vi.fn(() => Promise.resolve([1])),
    cancelTransfer: vi.fn(() => Promise.resolve()),
    pauseTransfer: vi.fn(() => Promise.resolve()),
    resumeTransfer: vi.fn(() => Promise.resolve()),
    retryTransfer: vi.fn(() => Promise.resolve()),
    answerConflict: vi.fn(() => Promise.resolve()),
    removeTransfers: vi.fn(() => Promise.resolve()),
  };
  let clock = 0;
  const store = createTransfersStore(api, () => clock);
  return {
    api,
    store,
    push: (t: Transfer) => push(t),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("transfers store", () => {
  it("starts from the backend's list and follows its changes, oldest first", async () => {
    const { store, push } = setup([transfer(2)]);
    await store.getState().watch();

    push(transfer(1, { state: { type: "queued" } }));
    push(transfer(2, { bytesDone: 500 }));

    expect(store.getState().transfers.map((t) => [t.id, t.bytesDone])).toEqual([
      [1, 0],
      [2, 500],
    ]);
  });

  it("measures each running transfer's speed from its progress", async () => {
    const { store, push, advance } = setup();
    await store.getState().watch();

    push(transfer(1, { bytesDone: 0, bytesTotal: 10_000 }));
    advance(500);
    push(transfer(1, { bytesDone: 1000, bytesTotal: 10_000 }));
    expect(store.getState().speeds[1]).toBe(2000);

    advance(1000);
    push(transfer(1, { bytesDone: 2000, bytesTotal: 10_000 }));
    // Smoothed: mostly the earlier rate, partly the new one (1000 B/s).
    expect(store.getState().speeds[1]).toBeGreaterThan(1000);
    expect(store.getState().speeds[1]).toBeLessThan(2000);

    push(transfer(1, { bytesDone: 10_000, bytesTotal: 10_000, state: { type: "done" } }));
    expect(store.getState().speeds[1]).toBeUndefined();
  });

  it("keeps early completion and replaces removed transfers and speed samples on rewatch", async () => {
    const { store, api, push, advance } = setup([transfer(1)]);
    await store.getState().watch();
    advance(100);
    push(transfer(1, { bytesDone: 500 }));
    expect(store.getState().speeds[1]).toBeGreaterThan(0);
    vi.mocked(api.watchTransfers).mockImplementationOnce(async receive => {
      receive(transfer(2, { state: { type: "done" } }));
      return [transfer(2)];
    });

    await store.getState().watch();
    expect(store.getState().transfers).toEqual([transfer(2, { state: { type: "done" } })]);
    expect(store.getState().speeds).toEqual({});
  });

  it("asks the backend to upload, download, cancel, retry and answer", async () => {
    const { api, store } = setup();
    const s = store.getState();
    const host = { id: "h1", name: "Web" };

    await s.upload(host, ["/a"], "/srv");
    await s.download(host, ["/srv/b"], "/dl");
    await s.cancel(3);
    await s.retry(4);
    await s.answer(5, "skipAll");

    expect(api.uploadFiles).toHaveBeenCalledWith(host, ["/a"], "/srv");
    expect(api.downloadFiles).toHaveBeenCalledWith(host, ["/srv/b"], "/dl");
    expect(api.cancelTransfer).toHaveBeenCalledWith(3);
    expect(api.retryTransfer).toHaveBeenCalledWith(4);
    expect(api.answerConflict).toHaveBeenCalledWith(5, "skipAll");
  });

  it("keeps a paused transfer available to resume and clears its speed", async () => {
    const { api, store, push, advance } = setup([transfer(1)]);
    await store.getState().watch();
    advance(100);
    push(transfer(1, { bytesDone: 200 }));
    expect(store.getState().speeds[1]).toBe(2000);

    await store.getState().pause(1);
    const paused = transfer(1, { bytesDone: 200, state: { type: "paused" } });
    push(paused);
    const { transfers, speeds } = store.getState();
    expect(activeTransfers(transfers)).toEqual([paused]);
    expect(transferSummary(transfers, speeds)).toEqual({ count: 0, bytesPerSecond: 0 });
    expect(speeds).toEqual({});

    await store.getState().dismiss([1]);
    expect(store.getState().transfers).toEqual([paused]);
    await store.getState().resume(1);
    expect(api.pauseTransfer).toHaveBeenCalledWith(1);
    expect(api.resumeTransfer).toHaveBeenCalledWith(1);
  });

  it("dismisses only finished transfers", async () => {
    const { api, store } = setup([
      transfer(1, { state: { type: "done" } }),
      transfer(2),
      transfer(3, { state: { type: "failed", message: "x" } }),
    ]);
    await store.getState().watch();

    await store.getState().dismiss([1, 2, 3]);

    expect(store.getState().transfers.map((t) => t.id)).toEqual([2]);
    expect(api.removeTransfers).toHaveBeenCalledWith([1, 3]);
  });

  it("clears completed transfers without removing any other state or a later completion", async () => {
    const { api, push, store } = setup([
      transfer(1, { state: { type: "done" } }),
      transfer(2, { state: { type: "failed", message: "x" } }),
      transfer(3, { state: { type: "cancelled" } }),
      transfer(4, { state: { type: "paused" } }),
      transfer(5),
    ]);
    await store.getState().watch();
    vi.mocked(api.removeTransfers).mockImplementationOnce(async () => {
      push(transfer(5, { state: { type: "done" } }));
    });

    await store.getState().clearCompleted();

    expect(store.getState().transfers.map(({ id }) => id)).toEqual([2, 3, 4, 5]);
    expect(api.removeTransfers).toHaveBeenCalledWith([1]);
  });
});

describe("transfer views", () => {
  it("groups filtered transfers by Host identity in queue order", () => {
    const web = { id: "h1", name: "Web" };
    const replica = { id: "h2", name: "Web" };
    const acrossHosts = [
      transfer(1, { state: { type: "done" }, sourceHost: web, direction: "download" }),
      transfer(2, { state: { type: "paused" }, targetHost: web }),
      transfer(3, { state: { type: "failed", message: "boom" }, targetHost: replica }),
      transfer(4, { state: { type: "conflict", path: "/dest" }, sourceHost: web, targetHost: replica, direction: "copy" }),
      transfer(5, { state: { type: "queued" }, sourceHost: replica, direction: "download" }),
      transfer(6, { state: { type: "cancelled" } }),
      transfer(7, { targetHost: web }),
    ];
    const groupedIds = (filter: Parameters<typeof transferGroups>[1]) =>
      transferGroups(acrossHosts, filter).map(({ host, transfers }) => [host?.id, transfers.map(({ id }) => id)]);

    expect(groupedIds("all")).toEqual([["h1", [1, 2, 4, 7]], ["h2", [3, 5]], [undefined, [6]]]);
    expect(groupedIds("inProgress")).toEqual([["h1", [2, 4, 7]], ["h2", [5]]]);
    expect(groupedIds("failed")).toEqual([["h2", [3]]]);
    expect(groupedIds("completed")).toEqual([["h1", [1]]]);
  });

  const all = [
    transfer(1, { state: { type: "done" } }),
    transfer(2, { state: { type: "conflict", path: "/remote/x" } }),
    transfer(3, { state: { type: "failed", message: "boom" } }),
    transfer(4, { state: { type: "queued" } }),
    transfer(5, { state: { type: "conflict", path: "/remote/y" } }),
  ];

  it("splits transfers into active (including failed) and done", () => {
    expect(activeTransfers(all).map((t) => t.id)).toEqual([2, 3, 4, 5]);
    expect(doneTransfers(all).map((t) => t.id)).toEqual([1]);
  });

  it("asks about the oldest conflict first", () => {
    expect(firstConflict(all)?.id).toBe(2);
    expect(firstConflict([transfer(1)])).toBeUndefined();
  });

  it("estimates the time left from the speed", () => {
    expect(timeLeft(transfer(1, { bytesDone: 400, bytesTotal: 1000 }), 200)).toBe(3);
    expect(timeLeft(transfer(1), undefined)).toBeNull();
    expect(timeLeft(transfer(1), 0)).toBeNull();
  });

  it("shows time left in seconds, minutes or hours", () => {
    expect(formatDuration(42)).toBe("42 s");
    expect(formatDuration(170)).toBe("3 min");
    expect(formatDuration(3900)).toBe("1 h 5 min");
  });

  it("summarises unfinished transfers and their total speed for the status bar", () => {
    const summary = transferSummary([...all, transfer(6), transfer(7)], { 6: 1000, 7: 500 });
    expect(summary).toEqual({ count: 5, bytesPerSecond: 1500 });
  });
});
