import type { StoreApi } from "zustand/vanilla";
import * as editIpc from "@/lib/ipc/edit";
import * as ipc from "@/lib/ipc/files";
import type { HostId } from "@/lib/ipc/hosts";
import { createFileBrowserStore, type FileBrowserState, type FilesApi } from "./fileBrowserStore";

export type FileBrowserStore = StoreApi<FileBrowserState>;

/** Every remote Terminal pane's File panel, by pane id. */
export interface FileBrowsers {
  /** The pane's File panel, created (closed) on first use, to open first in `startPath` (else home). */
  get(paneId: string, hostId: HostId, startPath?: string | null): FileBrowserStore;
  /** The pane's File panel if it has one, e.g. to `navigate` it from its Terminal. */
  find(paneId: string): FileBrowserStore | undefined;
  /** Closes and forgets the File panels (and their remote edits) of every pane not in `paneIds`. */
  retain(paneIds: ReadonlySet<string>): void;
}

export function createFileBrowsers(api: FilesApi): FileBrowsers {
  const stores = new Map<string, FileBrowserStore>();
  return {
    get(paneId, hostId, startPath) {
      let store = stores.get(paneId);
      if (!store) {
        store = createFileBrowserStore(api, hostId, startPath);
        stores.set(paneId, store);
      }
      return store;
    },
    find: (paneId) => stores.get(paneId),
    retain(paneIds) {
      for (const [paneId, store] of stores) {
        if (paneIds.has(paneId)) continue;
        store.getState().dispose();
        stores.delete(paneId);
      }
    },
  };
}

/** The app's File panels, over the real SFTP and remote edit commands. */
export const fileBrowsers = createFileBrowsers({ ...ipc, ...editIpc });
