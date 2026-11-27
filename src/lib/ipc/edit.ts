import { Channel, invoke } from "@tauri-apps/api/core";
import type { HostId } from "./hosts";

/** Mirrors `sshastra_core::edit::EditId`: one remote file open in the user's editor. */
export type EditId = number;

/** Mirrors `sshastra_core::edit::EditEvent`: what happened to a save. */
type EditUploadEvent = { state: "uploading" } | { state: "uploaded" } | { state: "uploadFailed"; reason: string };

export type EditEvent = EditUploadEvent | { state: "applicationFallback" };

/** The largest file opened for editing (`sshastra_core::edit::MAX_EDIT_SIZE`); bigger ones are downloaded instead. */
export const maxEditSize = 10 * 1024 * 1024;

/**
 * Downloads a remote file to a temp file and opens it in the chosen or system default application; each
 * save there is uploaded again, reported to `onEvent`. Uses the Host's live Connection. Opening a
 * file that is already open shows it again and resolves to the same id. Rejects with `notFound`,
 * `permissionDenied`, `notConnected`, `notAFile`, `tooLarge` (over `maxEditSize`), `binary` (a NUL
 * byte near the start; pass `allowBinary` once the user agrees), `openFailed` (no application for
 * it), `io` or `protocol`.
 */
export async function openRemoteEdit(
  hostId: HostId,
  path: string,
  onEvent: (event: EditEvent) => void,
  { allowBinary = false }: { allowBinary?: boolean } = {},
): Promise<EditId> {
  const { id, applicationFallback } = await invoke<{ id: EditId; applicationFallback: boolean }>("edit_open", {
    hostId, path, allowBinary, onEvent: new Channel<EditUploadEvent>(onEvent),
  });
  if (applicationFallback) onEvent({ state: "applicationFallback" });
  return id;
}

/** Uploads the temp file again now, e.g. after `uploadFailed`. */
export function retryRemoteEdit(id: EditId): Promise<void> {
  return invoke("edit_retry", { id });
}

/** Stops uploading and deletes the temp file. */
export function closeRemoteEdit(id: EditId): Promise<void> {
  return invoke("edit_close", { id });
}
