import { Channel, invoke } from "@tauri-apps/api/core";
import { connectPromptChannel, type ConnectPrompt, type PromptAnswer } from "./connect";
import type { HostId } from "./hosts";

/** Mirrors `sshastra_core::files::FsId`: one open remote file system (a File panel's SFTP session). */
export type FsId = number;

/** Listing metadata for one ordinary remote file. The OS asks for its bytes after a drop. */
export interface FilePromise {
  id: FsId;
  directory: string;
  name: string;
  size: number;
  modified: number | null;
}

export function dragFileOut(file: FilePromise): Promise<boolean> {
  return invoke("files_drag_out", { file });
}

/** Mirrors `sshastra_core::files::FileKind`. */
export type FileKind = "file" | "dir" | "symlink" | "other";

/** Mirrors `sshastra_core::files::FileEntry`. */
export interface FileEntry {
  name: string;
  kind: FileKind;
  /** Bytes. */
  size: number;
  /** Seconds since the Unix epoch. */
  modified: number | null;
  /** Permission bits only, e.g. `0o755`. */
  permissions: number | null;
  /** Numeric ownership when reported by SFTP. */
  uid?: number | null;
  gid?: number | null;
  /** For a symlink, what it points to (`null` if it dangles). */
  linkTarget: FileKind | null;
}

/** A directory's resolved absolute path and its entries, unordered. */
export interface Listing {
  path: string;
  entries: FileEntry[];
}

export type NameSearchMode = "substring" | "wildcard";

export interface NameMatch {
  parent: string;
  name: string;
}

export interface NameSearchResult {
  matches: NameMatch[];
  visited: number;
  limitReached: boolean;
  skippedDirectories: boolean;
}

/** Mirrors `sshastra_core::files::PermissionChange`. */
export interface PermissionChange {
  mode?: number;
  uid?: number;
  gid?: number;
  scope: "entry" | "recursive" | "directoriesOnly";
}

/**
 * Opens an SFTP session over the Host's live Connection (the one its Terminal uses); never
 * connects. Rejects with `kind: "notConnected"` if the Host has no Connection.
 */
export function openFiles(hostId: HostId): Promise<FsId> {
  return invoke<FsId>("files_open", { hostId });
}

/** Resolves the remote Home folder over the Host's live Connection. */
export function remoteHomeDirectory(hostId: HostId): Promise<string> {
  return invoke("files_remote_home", { hostId });
}

/** Connects for a standalone SFTP tab, without opening a Terminal. */
export function connectFiles(hostId: HostId, ask: (prompt: ConnectPrompt) => Promise<PromptAnswer>): Promise<FsId> {
  return invoke("files_connect", { hostId, onPrompt: connectPromptChannel(ask) });
}

export function openLocalFiles(): Promise<FsId> {
  return invoke("files_local_open");
}

export function deleteLocalFiles(_id: FsId, paths: string[]): Promise<void> {
  return invoke("files_local_delete", { paths });
}

export function openLocalPath(path: string): Promise<void> {
  return invoke("files_local_open_path", { path });
}

/**
 * Lists a directory. `""` and `~` are the home directory, `~/x` is under it; the server
 * resolves the rest (`..`, symlinks). Rejects with `notFound`, `permissionDenied`,
 * `notADirectory`, `timedOut`, `protocol` or `notOpen` (the file operations below too, plus
 * `alreadyExists`).
 */
export function listFiles(id: FsId, path: string): Promise<Listing> {
  return invoke<Listing>("files_list", { id, path });
}

/** Creates the directory `path`. Rejects with `alreadyExists` when the name is taken. */
export function createDir(id: FsId, path: string): Promise<void> {
  return invoke("files_create_dir", { id, path });
}

/** Creates an empty file at `path`. Rejects with `alreadyExists` when the name is taken. */
export function createEmptyFile(id: FsId, path: string): Promise<void> {
  return invoke("files_create_empty", { id, path });
}

/** Renames (moves) `from` to `to`; rejects with `alreadyExists` rather than replacing `to`. */
export function renameFile(id: FsId, from: string, to: string): Promise<void> {
  return invoke("files_rename", { id, from, to });
}

/** Creates a new tar.gz on the Host from entries in one directory. */
export function compressFiles(id: FsId, directory: string, names: readonly string[], archive: string): Promise<void> {
  return invoke("files_compress", { id, directory, names, archive });
}

/** Expands one archive on the Host into a new sibling folder. */
export function extractArchive(id: FsId, directory: string, archive: string): Promise<void> {
  return invoke("files_extract_archive", { id, directory, archive });
}

/**
 * How many entries deleting `paths` removes: each path itself plus, for a directory, everything
 * under it (symlinks are not followed). For the delete confirmation.
 */
export function countFiles(id: FsId, paths: string[]): Promise<number> {
  return invoke<number>("files_count", { id, paths });
}

/** Totals the bytes in a real folder. An aborted scan returns `null`. */
export function folderSize(id: FsId, path: string, signal: AbortSignal): Promise<number | null> {
  return scanFiles("files_folder_size", id, { path }, signal);
}

/** Searches descendant names on SFTP. An aborted scan returns `null`. */
export function searchNames(
  id: FsId, path: string, query: string, mode: NameSearchMode, signal: AbortSignal,
): Promise<NameSearchResult | null> {
  return scanFiles("files_search_names", id, { path, query, mode }, signal);
}

async function scanFiles<T>(
  command: string, id: FsId, args: Record<string, unknown>, signal: AbortSignal,
): Promise<T | null> {
  if (signal.aborted) return null;
  const finished = new AbortController();
  const onStart = new Channel<number>();
  onStart.onmessage = (requestId) => {
    if (finished.signal.aborted) return;
    const cancel = () => { void invoke("files_cancel_scan", { id, requestId }).catch(() => {}); };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true, signal: finished.signal });
  };
  try {
    return await invoke<T | null>(command, { ...args, id, onStart });
  } finally {
    finished.abort();
  }
}

/** Deletes `paths`, directories recursively; symlinks are deleted, not followed. Stops at the first failure. */
export function deleteFiles(id: FsId, paths: string[]): Promise<void> {
  return invoke("files_delete", { id, paths });
}

/** Edits ownership of `path` and applies the mode to the requested scope. */
export function chmodFile(id: FsId, path: string, change: PermissionChange): Promise<void> {
  return invoke("files_chmod", { id, path, change });
}

export function closeFiles(id: FsId): Promise<void> {
  return invoke("files_close", { id });
}
