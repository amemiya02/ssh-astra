import type { StoreApi } from "zustand/vanilla";
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
): () => void {
  return transfers.subscribe(({ transfers: next }, { transfers: before }) => {
    const dir = panel.getState().path;
    if (dir === null || panel.getState().phase !== "open") return;
    const wasFinished = new Set(before.filter(finished).map((t) => t.id));
    const landed = next.some(
      (t) =>
        t.direction === direction &&
        finished(t) &&
        !wasFinished.has(t.id) &&
        parentPath(windows ? t.target.replaceAll("\\", "/") : t.target) ===
          (windows && dir.endsWith("/") ? dir.slice(0, -1) : dir),
    );
    if (landed) void panel.getState().refresh();
  });
}
