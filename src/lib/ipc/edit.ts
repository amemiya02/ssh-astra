import { Channel, invoke } from "@tauri-apps/api/core";
import type { HostId } from "./hosts";

/** Mirrors `sshastra_core::edit::EditId`: one remote file open in the user's editor. */
export type EditId = number;

/** Mirrors `sshastra_core::edit::EditEvent`: what happened to a save. */
export type EditEvent = { state: "uploading" } | { state: "uploaded" } | { state: "uploadFailed"; reason: string };

/**
 * Downloads a remote file to a temp file and opens it in the system's default application; each
 * save there is uploaded again, reported to `onEvent`. Uses the Host's live Connection. Opening a
 * file that is already open shows it again and resolves to the same id. Rejects with `notFound`,
 * `permissionDenied`, `notConnected`, `openFailed` (no application for it), `io` or `protocol`.
 */
export function openRemoteEdit(hostId: HostId, path: string, onEvent: (event: EditEvent) => void): Promise<EditId> {
  return invoke<EditId>("edit_open", { hostId, path, onEvent: new Channel<EditEvent>(onEvent) });
}

/** Uploads the temp file again now, e.g. after `uploadFailed`. */
export function retryRemoteEdit(id: EditId): Promise<void> {
  return invoke("edit_retry", { id });
}

/** Stops uploading and deletes the temp file. */
export function closeRemoteEdit(id: EditId): Promise<void> {
  return invoke("edit_close", { id });
}
