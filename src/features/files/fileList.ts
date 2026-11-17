import type { FileEntry } from "@/lib/ipc/files";

/** The File panel's sortable columns. */
export type SortKey = "name" | "size" | "modified" | "permissions";
export interface FileSort {
  key: SortKey;
  direction: "asc" | "desc";
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byName = (a: FileEntry, b: FileEntry) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1);

const column: Record<Exclude<SortKey, "name">, (entry: FileEntry) => number> = {
  size: (e) => e.size,
  modified: (e) => e.modified ?? -Infinity,
  permissions: (e) => e.permissions ?? -1,
};

/** Directories, and symlinks to them, open on double-click and sort before files. */
export function isDirLike(entry: FileEntry): boolean {
  return entry.kind === "dir" || (entry.kind === "symlink" && entry.linkTarget === "dir");
}

/**
 * The rows the File panel shows, in order: directories first, then files, each sorted by
 * `sort` (ties by name); dotfiles only with `showHidden`.
 */
export function shownEntries(entries: readonly FileEntry[], sort: FileSort, showHidden: boolean): FileEntry[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  const value = sort.key === "name" ? null : column[sort.key];
  const compare = (a: FileEntry, b: FileEntry) =>
    value ? sign * (value(a) - value(b)) || byName(a, b) : sign * byName(a, b);
  return entries
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .sort((a, b) => Number(isDirLike(b)) - Number(isDirLike(a)) || compare(a, b));
}

/** The directory above `path`; the root is its own parent. */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

/** `name` inside the directory `dir`. */
export function childPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

const typeLetter: Record<FileEntry["kind"], string> = { dir: "d", symlink: "l", file: "-", other: "?" };

/** `drwxr-xr-x`, as `ls -l` shows it; empty when the server did not say. */
export function formatPermissions(entry: FileEntry): string {
  const mode = entry.permissions;
  if (mode === null) return "";
  const triple = (shift: number, special: boolean, specialChar: string) => {
    const bits = (mode >> shift) & 7;
    const exec = bits & 1;
    const x = special ? (exec ? specialChar : specialChar.toUpperCase()) : exec ? "x" : "-";
    return `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${x}`;
  };
  return (
    typeLetter[entry.kind] +
    triple(6, (mode & 0o4000) !== 0, "s") +
    triple(3, (mode & 0o2000) !== 0, "s") +
    triple(0, (mode & 0o1000) !== 0, "t")
  );
}

/** Why `name` cannot be given to a new or renamed entry in a directory holding `existing`. */
export type NameProblem = "empty" | "slash" | "dots" | "taken";

/** `current` is the entry's own name when renaming (keeping it is fine). */
export function nameProblem(name: string, existing: readonly string[], current?: string): NameProblem | null {
  if (name.trim() === "") return "empty";
  if (name.includes("/")) return "slash";
  if (name === "." || name === "..") return "dots";
  if (name !== current && existing.includes(name)) return "taken";
  return null;
}

/** `755` or `0644` (special bits: `1777`) as permission bits; `null` unless 3–4 octal digits. */
export function parseOctalMode(text: string): number | null {
  const trimmed = text.trim();
  return /^[0-7]{3,4}$/.test(trimmed) ? parseInt(trimmed, 8) : null;
}

/** Permission bits as `chmod` takes them: `755`, or `4755` with special bits. */
export function octalMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, "0");
}

const units = ["B", "KB", "MB", "GB", "TB", "PB"];

/** `1.5 KB`: binary units, at most one decimal. */
export function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : String(Math.round(value * 10) / 10);
  return `${rounded} ${units[unit]}`;
}

/** The rows `[start, end)` a fixed-row-height list renders: those in view plus `overscan` either side. */
export function visibleRows({
  scrollTop,
  viewport,
  rowHeight,
  count,
  overscan,
}: {
  scrollTop: number;
  viewport: number;
  rowHeight: number;
  count: number;
  overscan: number;
}): { start: number; end: number } {
  const first = Math.floor(scrollTop / rowHeight);
  const last = Math.ceil((scrollTop + viewport) / rowHeight);
  return { start: Math.max(0, Math.min(count, first - overscan)), end: Math.min(count, last + overscan) };
}
