import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { e2eHooks } from "@/lib/e2e";
import type { HostId } from "./hosts";

/** Mirrors `sshastra_core::files::TransferId`. */
export type TransferId = number;

/** Mirrors `sshastra_core::files::TransferState`. */
export type TransferState =
  | { type: "queued" }
  | { type: "running" }
  /** Paused until `answerConflict`: `path` already exists at the destination. */
  | { type: "conflict"; path: string }
  | { type: "done" }
  | { type: "failed"; message: string }
  | { type: "cancelled" };

/** A transfer endpoint's saved Host identity and label. */
export interface TransferHost {
  id: HostId;
  name: string;
  temporary?: boolean;
}

/** Mirrors `sshastra_core::files::Transfer`: one dropped or picked file or folder. */
export interface Transfer {
  id: TransferId;
  direction: "upload" | "download" | "copy";
  name: string;
  /** Full paths of the copy's source and target. */
  source: string;
  target: string;
  sourceHost?: TransferHost;
  targetHost?: TransferHost;
  state: TransferState;
  unprotected: boolean;
  /** Totals are 0 until a folder has been walked. */
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
}

/** Mirrors `sshastra_core::files::ConflictAnswer`; the `All` answers hold until the queue is idle. */
export type ConflictAnswer = "overwrite" | "skip" | "overwriteAll" | "skipAll";

/**
 * Sends every later change to `onEvent` (progress at most every 100 ms per transfer) and
 * resolves with every transfer now. One watcher at a time: a new call replaces the old.
 */
export function watchTransfers(onEvent: (transfer: Transfer) => void): Promise<Transfer[]> {
  return invoke<Transfer[]>("transfers_watch", { onEvent: new Channel<Transfer>(onEvent) });
}

/** Queues uploading local files or folders into `remoteDir` over the Host's live Connection. */
export function uploadFiles(hostId: HostId, paths: string[], remoteDir: string): Promise<TransferId[]> {
  return invoke<TransferId[]>("transfers_upload", { hostId, paths, remoteDir });
}

/** Queues downloading remote files or folders (absolute paths) into the local folder `localDir`. */
export function downloadFiles(hostId: HostId, paths: string[], localDir: string): Promise<TransferId[]> {
  return invoke<TransferId[]>("transfers_download", { hostId, paths, localDir });
}

/** Queues copying absolute paths from one Host into a directory on another. */
export function copyRemoteFiles(
  source: TransferHost, paths: string[], target: TransferHost, remoteDir: string,
): Promise<TransferId[]> {
  return invoke<TransferId[]>("transfers_copy_remote", { source, paths, target, remoteDir });
}

export function cancelTransfer(id: TransferId): Promise<void> {
  return invoke("transfer_cancel", { id });
}

/** Queues a failed or cancelled transfer again; files it already copied are kept. */
export function retryTransfer(id: TransferId): Promise<void> {
  return invoke("transfer_retry", { id });
}

export function answerConflict(id: TransferId, answer: ConflictAnswer): Promise<void> {
  return invoke("transfer_answer", { id, answer });
}

/** Forgets finished transfers. */
export function removeTransfers(ids: TransferId[]): Promise<void> {
  return invoke("transfers_remove", { ids });
}

/** The native picker for files to upload; `null` if cancelled. */
export async function pickFilesToUpload(title: string): Promise<string[] | null> {
  const queued = e2eHooks?.pickedFiles.shift();
  if (queued) return queued;
  const picked = await open({ multiple: true, directory: false, title });
  return picked && picked.length > 0 ? picked : null;
}

/** The native picker for the folder a download goes to; `null` if cancelled. */
export function pickDownloadFolder(title: string): Promise<string | null> {
  return open({ multiple: false, directory: true, title });
}

/** Files dragged from the system's file manager over the window (CSS pixels, from the top left). */
export type OsFileDrag =
  | { type: "over"; x: number; y: number }
  | { type: "drop"; x: number; y: number; paths: string[] }
  | { type: "leave" };

/**
 * Follows files dragged in from the system's file manager (Tauri's native drag and drop).
 * Resolves with the function that stops following.
 */
export async function onOsFileDrag(handler: (drag: OsFileDrag) => void): Promise<() => void> {
  return getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === "leave") return handler({ type: "leave" });
    // Physical pixels; the page lays out in CSS pixels.
    const scale = window.devicePixelRatio || 1;
    const x = payload.position.x / scale;
    const y = payload.position.y / scale;
    if (payload.type === "drop") handler({ type: "drop", x, y, paths: payload.paths });
    else handler({ type: "over", x, y });
  });
}
