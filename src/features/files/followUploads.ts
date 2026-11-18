import type { StoreApi } from "zustand/vanilla";
import type { Transfer } from "@/lib/ipc/transfers";
import type { FileBrowserState } from "./fileBrowserStore";
import { parentPath } from "./fileList";

const finished = (t: Transfer) => t.state.type === "done" || t.state.type === "failed" || t.state.type === "cancelled";

/**
 * Refreshes a File panel's listing whenever an upload into the folder it shows finishes (a
 * failed or cancelled one may have left or removed a file too). Returns the function that stops.
 */
export function followUploads(
  panel: StoreApi<FileBrowserState>,
  transfers: StoreApi<{ transfers: Transfer[] }>,
): () => void {
  return transfers.subscribe(({ transfers: next }, { transfers: before }) => {
    const dir = panel.getState().path;
    if (dir === null || panel.getState().phase !== "open") return;
    const wasFinished = new Set(before.filter(finished).map((t) => t.id));
    const landed = next.some(
      (t) => t.direction === "upload" && finished(t) && !wasFinished.has(t.id) && parentPath(t.target) === dir,
    );
    if (landed) void panel.getState().refresh();
  });
}
