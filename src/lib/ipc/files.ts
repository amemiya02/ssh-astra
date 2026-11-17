import { invoke } from "@tauri-apps/api/core";
import type { HostId } from "./hosts";

/** Mirrors `sshastra_core::files::FsId`: one open remote file system (a File panel's SFTP session). */
export type FsId = number;

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
  /** For a symlink, what it points to (`null` if it dangles). */
  linkTarget: FileKind | null;
}

/** A directory's resolved absolute path and its entries, unordered. */
export interface Listing {
  path: string;
  entries: FileEntry[];
}

/**
 * Opens an SFTP session over the Host's live Connection (the one its Terminal uses); never
 * connects. Rejects with `kind: "notConnected"` if the Host has no Connection.
 */
export function openFiles(hostId: HostId): Promise<FsId> {
  return invoke<FsId>("files_open", { hostId });
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

/** Renames (moves) `from` to `to`; rejects with `alreadyExists` rather than replacing `to`. */
export function renameFile(id: FsId, from: string, to: string): Promise<void> {
  return invoke("files_rename", { id, from, to });
}

/**
 * How many entries deleting `paths` removes: each path itself plus, for a directory, everything
 * under it (symlinks are not followed). For the delete confirmation.
 */
export function countFiles(id: FsId, paths: string[]): Promise<number> {
  return invoke<number>("files_count", { id, paths });
}

/** Deletes `paths`, directories recursively; symlinks are deleted, not followed. Stops at the first failure. */
export function deleteFiles(id: FsId, paths: string[]): Promise<void> {
  return invoke("files_delete", { id, paths });
}

/** Sets the permission bits of `path` (e.g. `0o755`). */
export function chmodFile(id: FsId, path: string, mode: number): Promise<void> {
  return invoke("files_chmod", { id, path, mode });
}

export function closeFiles(id: FsId): Promise<void> {
  return invoke("files_close", { id });
}
