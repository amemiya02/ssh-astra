import type { StoreApi } from "zustand/vanilla";
import type { HostId } from "@/lib/ipc/hosts";
import type { Transfer } from "@/lib/ipc/transfers";
import type { FileBrowserState } from "./fileBrowserStore";
import { parentPath } from "./fileList";

const finished = (t: Transfer) => t.state.type === "done" || t.state.type === "failed" || t.state.type === "cancelled";

/**
 * Refreshes a File panel's listing whenever a transfer into the folder it shows finishes (a
 * failed or cancelled one may have left or removed a file too). Returns the function that stops.
 */
export function followUploads(
  panel: StoreApi<FileBrowserState>,
  transfers: StoreApi<{ transfers: Transfer[] }>,
  direction: Transfer["direction"] = "upload",
  windows = false,
  hostId?: HostId,
): () => void {
  return followTransferFinishes(transfers, (settled) => {
    const { path, phase, refresh } = panel.getState();
    if (path === null || phase !== "open") return;
    const dir = windows && path.endsWith("/") ? path.slice(0, -1) : path;
    const landed = settled.some(
      (t) =>
        (t.direction === direction ||
          (direction === "upload" && hostId !== undefined && t.direction === "copy" && t.targetHost?.id === hostId)) &&
        parentPath(windows ? t.target.replaceAll("\\", "/") : t.target) === dir,
    );
    if (landed) void refresh();
  });
}

/** Runs only when a transfer finishes, including after a retry. */
export function followTransferFinishes(
  transfers: StoreApi<{ transfers: Transfer[] }>,
  onFinish: (settled: Transfer[]) => void,
): () => void {
  return transfers.subscribe(({ transfers: next }, { transfers: before }) => {
    if (next === before) return;
    const changed = next.filter((t, index) => t !== before[index] && finished(t));
    if (!changed.length) return;
    const wasFinished = new Set(before.filter(finished).map((t) => t.id));
    const settled = changed.filter((t) => !wasFinished.has(t.id));
    if (settled.length) onFinish(settled);
  });
}
