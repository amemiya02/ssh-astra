import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { Transfer } from "@/lib/ipc/transfers";
import { createFileBrowserStore, type FilesApi } from "./fileBrowserStore";
import { followUploads } from "./followUploads";

const upload = (id: number, target: string, state: Transfer["state"]): Transfer => ({
  id,
  direction: "upload",
  name: target.slice(target.lastIndexOf("/") + 1),
  source: `/local/${id}`,
  target,
  state,
  bytesDone: 0,
  bytesTotal: 0,
  filesDone: 0,
  filesTotal: 0,
});

async function setup() {
  const listFiles = vi.fn<FilesApi["listFiles"]>((_id, path) =>
    Promise.resolve({ path: path === "" ? "/home/me" : path, entries: [] }),
  );
  const api = {
    openFiles: vi.fn(() => Promise.resolve(1)),
    listFiles,
    closeFiles: vi.fn(() => Promise.resolve()),
  } as unknown as FilesApi;
  const panel = createFileBrowserStore(api, "host-1");
  await panel.getState().connect();
  const transfers = createStore<{ transfers: Transfer[] }>()(() => ({ transfers: [] }));
  const stop = followUploads(panel, transfers);
  listFiles.mockClear();
  const push = (...list: Transfer[]) => transfers.setState({ transfers: list });
  return { listFiles, push, stop };
}

describe("followUploads", () => {
  it("refreshes the listing when an upload into the folder shown finishes", async () => {
    const { listFiles, push } = await setup();

    push(upload(1, "/home/me/a.txt", { type: "running" }));
    expect(listFiles).not.toHaveBeenCalled();
    push(upload(1, "/home/me/a.txt", { type: "done" }));

    expect(listFiles).toHaveBeenCalledTimes(1);
    expect(listFiles).toHaveBeenCalledWith(1, "/home/me");
  });

  it("ignores uploads elsewhere, downloads, and transfers that were already finished", async () => {
    const { listFiles, push } = await setup();

    push(upload(1, "/srv/a.txt", { type: "running" }));
    push(upload(1, "/srv/a.txt", { type: "done" }));
    push(upload(1, "/srv/a.txt", { type: "done" }), {
      ...upload(2, "/home/me/b.txt", { type: "done" }),
      direction: "download",
      source: "/home/me/b.txt",
      target: "/local/b.txt",
    });

    expect(listFiles).not.toHaveBeenCalled();
  });

  it("stops following when asked", async () => {
    const { listFiles, push, stop } = await setup();
    stop();
    push(upload(1, "/home/me/a.txt", { type: "done" }));
    expect(listFiles).not.toHaveBeenCalled();
  });
});
