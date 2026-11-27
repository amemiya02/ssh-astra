import { Channel, invoke } from "@tauri-apps/api/core";
import type { HostId } from "./hosts";

/** Mirrors `sshastra_core::edit::EditId`: one remote file open in the user's editor. */
export type EditId = number;

/** Mirrors `sshastra_core::edit::EditEvent`: what happened to a save. */
type EditUploadEvent =
  | { state: "uploading" }
  | { state: "uploaded" }
  | { state: "uploadFailed"; reason: string }
  | { state: "conflict"; conflictId: number; reason?: string };

export type EditEvent = EditUploadEvent | { state: "applicationFallback" };

interface OpenedEdit {
  id: EditId;
  applicationFallback: boolean;
}

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
  return openEdit("edit_open", { hostId, path, allowBinary }, onEvent);
}

/** Opens the remote revision as a separate edit, leaving the original local copy in place. */
export function openRemoteEditConflictCopy(
  id: EditId,
  conflictId: number,
  onEvent: (event: EditEvent) => void,
): Promise<EditId> {
  return openEdit("edit_open_conflict_copy", { id, conflictId }, onEvent);
}

async function openEdit(
  command: "edit_open" | "edit_open_conflict_copy",
  args: { hostId: HostId; path: string; allowBinary: boolean } | { id: EditId; conflictId: number },
  onEvent: (event: EditEvent) => void,
): Promise<EditId> {
  const { id, applicationFallback } = await invoke<OpenedEdit>(command, {
    ...args, onEvent: new Channel<EditUploadEvent>(onEvent),
  });
  if (applicationFallback) onEvent({ state: "applicationFallback" });
  return id;
}

/** Uploads the latest local save after the user explicitly approves the conflict. */
export function overwriteRemoteEdit(id: EditId, conflictId: number): Promise<void> {
  return invoke("edit_overwrite", { id, conflictId });
}

/** Uploads the temp file again now, e.g. after `uploadFailed`. */
export function retryRemoteEdit(id: EditId): Promise<void> {
  return invoke("edit_retry", { id });
}

/** Stops uploading and deletes the temp file. */
export function closeRemoteEdit(id: EditId): Promise<void> {
  return invoke("edit_close", { id });
}
