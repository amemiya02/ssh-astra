import type { StoreApi } from "zustand/vanilla";
import { followTerminalDirectory } from "@/features/terminal/shellIntegration";
import { transfersStore } from "@/features/transfers/transfersStore";
import type { ConnectionStatus } from "@/features/workspace/tabs";
import * as editIpc from "@/lib/ipc/edit";
import * as ipc from "@/lib/ipc/files";
import type { Transfer } from "@/lib/ipc/transfers";
import type { HostId } from "@/lib/ipc/hosts";
import { getSetting } from "@/lib/storage";
import { createFileBrowserStore, followConnection, type FileBrowserState, type FilesApi } from "./fileBrowserStore";
import { filesSetting } from "./file-prefs";
import { parentPath } from "./fileList";
import { followTransferFinishes } from "./followUploads";
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

export function createFileBrowsers(
  api: FilesApi,
  editsForPanel = createSharedRemoteEdits(api),
  transfers?: StoreApi<{ transfers: Transfer[] }>,
  followDirectory?: (paneId: string, path: string) => void,
): FileBrowsers {
  const panes = new Map<string, {
    hostId: HostId;
    store: FileBrowserStore;
    status?: ConnectionStatus;
  }>();
  const visible = new Map<string, ConnectionStatus>();
  if (transfers) followTransferFinishes(transfers, (settled) => {
    const directoriesByHost = new Map<HostId, string[]>();
    for (const transfer of settled) {
      const host = transfer.targetHost;
      if (transfer.direction !== "copy" || !host) continue;
      const directories = directoriesByHost.get(host.id) ?? [];
      directories.push(parentPath(transfer.target));
      directoriesByHost.set(host.id, directories);
    }
    if (!directoriesByHost.size) return;
    // A panel keeps its listing when another Terminal is focused.
    for (const pane of panes.values()) {
      const directories = directoriesByHost.get(pane.hostId);
      if (directories) void pane.store.getState().refreshAfterMove(directories);
    }
  });
  return {
    get(paneId, hostId, startPath) {
      let pane = panes.get(paneId);
      if (!pane) {
        const refreshHostAfterMove = async (directories: readonly string[]) => {
          await Promise.all([...panes.values()]
            .filter((other) => other.hostId === hostId)
            .map((other) => other.store.getState().refreshAfterMove(directories)));
        };
        const store = createFileBrowserStore(api, hostId, startPath, undefined, editsForPanel, refreshHostAfterMove, (path) => {
          const shown = visible.get(paneId);
          if (shown && (panes.get(paneId)?.status ?? shown) === "connected") followDirectory?.(paneId, path);
        });
        pane = { hostId, store };
        panes.set(paneId, pane);
      }
      return pane.store;
    },
    find: (paneId) => panes.get(paneId)?.store,
    connectionChanged(paneId, status) {
      const pane = panes.get(paneId);
      if (!pane) return;
      pane.status = status;
      followConnection(pane.store, status, visible.has(paneId));
    },
    show(paneId, initialStatus) {
      const pane = panes.get(paneId);
      visible.set(paneId, initialStatus);
      if (pane) followConnection(pane.store, pane.status ?? initialStatus, true);
      return () => {
        pane?.store.getState().clearSearch();
        visible.delete(paneId);
      };
    },
    retain(paneIds) {
      for (const [paneId, pane] of panes) {
        if (paneIds.has(paneId)) continue;
        pane.store.getState().dispose();
        panes.delete(paneId);
        visible.delete(paneId);
      }
    },
  };
}

/** The app's File panels, over the real SFTP and remote edit commands. */
export const fileBrowsers = createFileBrowsers({ ...ipc, ...editIpc }, sharedRemoteEdits, transfersStore, (paneId, path) => {
  if (getSetting(filesSetting).terminalFollowsFilePanel) followTerminalDirectory(paneId, path);
});
