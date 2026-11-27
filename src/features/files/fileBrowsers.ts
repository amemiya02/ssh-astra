import type { StoreApi } from "zustand/vanilla";
import type { ConnectionStatus } from "@/features/workspace/tabs";
import * as editIpc from "@/lib/ipc/edit";
import * as ipc from "@/lib/ipc/files";
import type { HostId } from "@/lib/ipc/hosts";
import { createFileBrowserStore, followConnection, type FileBrowserState, type FilesApi } from "./fileBrowserStore";
import { createSharedRemoteEdits, sharedRemoteEdits } from "./sharedRemoteEdits";

export type FileBrowserStore = StoreApi<FileBrowserState>;

/** Every remote Terminal pane's File panel, by pane id. */
export interface FileBrowsers {
  /** The pane's File panel, created (closed) on first use, to open first in `startPath` (else home). */
  get(paneId: string, hostId: HostId, startPath?: string | null): FileBrowserStore;
  /** The pane's File panel if it has one, e.g. to `navigate` it from its Terminal. */
  find(paneId: string): FileBrowserStore | undefined;
  /** Follows this pane’s Connection even while another tab has focus. */
  connectionChanged(paneId: string, status: ConnectionStatus): void;
  /** Opens SFTP when ready. The returned cleanup hides the panel while keeping its directory. */
  show(paneId: string, initialStatus: ConnectionStatus): () => void;
  /** Closes and forgets the File panels (and their remote edits) of every pane not in `paneIds`. */
  retain(paneIds: ReadonlySet<string>): void;
}

export function createFileBrowsers(api: FilesApi, editsForPanel = createSharedRemoteEdits(api)): FileBrowsers {
  const panes = new Map<string, { hostId: HostId; store: FileBrowserStore; status?: ConnectionStatus }>();
  let visible: string | null = null;
  return {
    get(paneId, hostId, startPath) {
      let pane = panes.get(paneId);
      if (!pane) {
        const refreshHostAfterMove = async (directories: readonly string[]) => {
          await Promise.all([...panes.values()]
            .filter((other) => other.hostId === hostId)
            .map((other) => other.store.getState().refreshAfterMove(directories)));
        };
        pane = { hostId, store: createFileBrowserStore(api, hostId, startPath, undefined, editsForPanel, refreshHostAfterMove) };
        panes.set(paneId, pane);
      }
      return pane.store;
    },
    find: (paneId) => panes.get(paneId)?.store,
    connectionChanged(paneId, status) {
      const pane = panes.get(paneId);
      if (!pane) return;
      pane.status = status;
      followConnection(pane.store, status, visible === paneId);
    },
    show(paneId, initialStatus) {
      const pane = panes.get(paneId);
      visible = paneId;
      if (pane) followConnection(pane.store, pane.status ?? initialStatus, true);
      return () => {
        pane?.store.getState().clearSearch();
        if (visible === paneId) visible = null;
      };
    },
    retain(paneIds) {
      for (const [paneId, pane] of panes) {
        if (paneIds.has(paneId)) continue;
        pane.store.getState().dispose();
        panes.delete(paneId);
        if (visible === paneId) visible = null;
      }
    },
  };
}

/** The app's File panels, over the real SFTP and remote edit commands. */
export const fileBrowsers = createFileBrowsers({ ...ipc, ...editIpc }, sharedRemoteEdits);
