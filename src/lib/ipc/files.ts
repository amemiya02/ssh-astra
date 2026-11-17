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
 * `notADirectory`, `timedOut`, `protocol` or `notOpen`.
 */
export function listFiles(id: FsId, path: string): Promise<Listing> {
  return invoke<Listing>("files_list", { id, path });
}

export function closeFiles(id: FsId): Promise<void> {
  return invoke("files_close", { id });
}
