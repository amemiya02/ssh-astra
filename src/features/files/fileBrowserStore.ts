import { createStore, type StoreApi } from "zustand/vanilla";
import type { ConnectionStatus } from "@/features/workspace/tabs";
import { readCommandError, type CommandError } from "@/lib/ipc/connect";
import * as ipc from "@/lib/ipc/files";
import type { FileEntry, FsId } from "@/lib/ipc/files";
import type { HostId } from "@/lib/ipc/hosts";
import { childPath, isDirLike, parentPath } from "./fileList";

/** The SFTP commands a File panel uses (`@/lib/ipc/files`); a fake in tests. */
export type FilesApi = Pick<
  typeof ipc,
  "openFiles" | "listFiles" | "closeFiles" | "createDir" | "renameFile" | "countFiles" | "deleteFiles" | "chmodFile"
>;

/** How a click changes the selection: plain, Cmd/Ctrl, Shift. */
export type SelectMode = "only" | "toggle" | "range";

export interface FileBrowserState {
  /** `closed` until `connect`, and again after `disconnect` or a failed open. */
  phase: "closed" | "opening" | "open";
  /** The directory shown (absolute, as the server resolved it); `null` before the first listing. */
  path: string | null;
  /** The directory's entries, unordered (the view sorts and filters them). */
  entries: FileEntry[];
  /** A listing is on its way. */
  loading: boolean;
  /** Why the last open or navigation failed; the previous listing stays shown. */
  error: CommandError | null;
  /** Selected entry names in `path`. File operations and transfers act on these. */
  selection: ReadonlySet<string>;

  /** Opens an SFTP session on the Host's live Connection, then lists where it was (first time: home). */
  connect(): Promise<void>;
  /** Shows `path`: absolute, `~`, `~/x`, or relative to home. Following the Terminal's `cd` calls this. */
  navigate(path: string): Promise<void>;
  up(): Promise<void>;
  refresh(): Promise<void>;
  /** Enters a directory (or a link to one); does nothing for files. */
  open(entry: FileEntry): Promise<void>;
  /** `order` is the names as displayed, for Shift-click ranges. */
  select(name: string, mode: SelectMode, order: readonly string[]): void;
  // File operations act on entries of `path` by name. Each refreshes the listing and resolves with
  // why it failed (`null` on success), for the dialog that asked; they leave `error` alone.
  /** Creates the folder `name` and selects it. */
  createFolder(name: string): Promise<CommandError | null>;
  /** Renames `name` to `newName` (never over an existing entry) and selects it. */
  rename(name: string, newName: string): Promise<CommandError | null>;
  /** How many entries deleting `names` removes, folders' contents included. */
  countForDelete(names: readonly string[]): Promise<{ count: number } | { error: CommandError }>;
  /** Deletes `names`, folders with everything in them. */
  remove(names: readonly string[]): Promise<CommandError | null>;
  /** Sets the permission bits of `name`. */
  setPermissions(name: string, mode: number): Promise<CommandError | null>;
  /** Closes the SFTP session (the Connection dropped, or the pane closed); keeps the path for `connect`. */
  disconnect(): void;
}

const notOpen: CommandError = { kind: "notOpen", message: "the File panel is not open" };

/**
 * One File panel's state: the SFTP session over its Host's Connection, the directory shown
 * and the selection. Actions never reject; failures land in `error`.
 */
export function createFileBrowserStore(api: FilesApi, hostId: HostId): StoreApi<FileBrowserState> {
  let fsId: FsId | null = null;
  let opening: Promise<void> | null = null;
  /** Bumped by `disconnect`, so an open that finishes afterwards is closed again. */
  let session = 0;
  /** Bumped by each listing request; only the latest one is shown. */
  let request = 0;
  let anchor: string | null = null;

  return createStore<FileBrowserState>()((set, get) => {
    const list = async (path: string, keepSelection: boolean) => {
      if (fsId === null) return;
      const mine = ++request;
      set({ loading: true });
      try {
        const listing = await api.listFiles(fsId, path);
        if (mine !== request) return;
        const names = new Set(listing.entries.map((e) => e.name));
        const samePath = listing.path === get().path;
        const selection =
          keepSelection && samePath ? new Set([...get().selection].filter((n) => names.has(n))) : new Set<string>();
        if (!selection.has(anchor ?? "")) anchor = null;
        set({ path: listing.path, entries: listing.entries, selection, loading: false, error: null });
      } catch (e) {
        if (mine !== request) return;
        set({ loading: false, error: readCommandError(e) });
      }
    };

    /** Runs an operation on the open session, then refreshes (also after a partial failure). */
    const operate = async (
      run: (id: FsId, dir: string) => Promise<void>,
      select?: string,
    ): Promise<CommandError | null> => {
      const dir = get().path;
      if (fsId === null || dir === null) return notOpen;
      let failure: CommandError | null = null;
      try {
        await run(fsId, dir);
      } catch (e) {
        failure = readCommandError(e);
      }
      // Unless the user has gone elsewhere meanwhile.
      if (get().path === dir) await list(dir, true);
      if (failure === null && select !== undefined && get().entries.some((e) => e.name === select)) {
        anchor = select;
        set({ selection: new Set([select]) });
      }
      return failure;
    };

    return {
      phase: "closed",
      path: null,
      entries: [],
      loading: false,
      error: null,
      selection: new Set(),

      connect() {
        if (get().phase === "open") return Promise.resolve();
        opening ??= (async () => {
          const mine = session;
          set({ phase: "opening", error: null });
          try {
            const id = await api.openFiles(hostId);
            if (mine !== session) {
              void api.closeFiles(id).catch(() => {});
              return;
            }
            fsId = id;
            set({ phase: "open" });
            await list(get().path ?? "", true);
          } catch (e) {
            if (mine === session) set({ phase: "closed", error: readCommandError(e) });
          } finally {
            opening = null;
          }
        })();
        return opening;
      },

      navigate: (path) => list(path, false),
      up: () => list(parentPath(get().path ?? "/"), false),
      refresh: () => list(get().path ?? "", true),
      async open(entry) {
        const dir = get().path;
        if (dir !== null && isDirLike(entry)) await list(childPath(dir, entry.name), false);
      },

      select(name, mode, order) {
        const current = get().selection;
        if (mode === "toggle") {
          const next = new Set(current);
          if (!next.delete(name)) next.add(name);
          anchor = name;
          set({ selection: next });
          return;
        }
        if (mode === "range" && anchor !== null) {
          const from = order.indexOf(anchor);
          const to = order.indexOf(name);
          if (from >= 0 && to >= 0) {
            const [lo, hi] = from < to ? [from, to] : [to, from];
            set({ selection: new Set(order.slice(lo, hi + 1)) });
            return;
          }
        }
        anchor = name;
        set({ selection: new Set([name]) });
      },

      createFolder: (name) => operate((id, dir) => api.createDir(id, childPath(dir, name)), name),
      rename: (name, newName) =>
        operate((id, dir) => api.renameFile(id, childPath(dir, name), childPath(dir, newName)), newName),
      async countForDelete(names) {
        const dir = get().path;
        if (fsId === null || dir === null) return { error: notOpen };
        try {
          return { count: await api.countFiles(fsId, names.map((n) => childPath(dir, n))) };
        } catch (e) {
          return { error: readCommandError(e) };
        }
      },
      remove: (names) => operate((id, dir) => api.deleteFiles(id, names.map((n) => childPath(dir, n)))),
      setPermissions: (name, mode) => operate((id, dir) => api.chmodFile(id, childPath(dir, name), mode)),

      disconnect() {
        session += 1;
        request += 1;
        opening = null;
        if (fsId !== null) void api.closeFiles(fsId).catch(() => {});
        fsId = null;
        set({ phase: "closed", loading: false });
      },
    };
  });
}

/**
 * Keeps a File panel in step with its Terminal's Connection: opens SFTP once the Terminal is
 * `connected` and the panel is `shown`, and closes it whenever the Connection is not up. A
 * reconnect (`connected` → `connecting` → `connected`) so drops the old SFTP session and opens a
 * new one on the new Connection, at the same path.
 */
export function followConnection(store: StoreApi<FileBrowserState>, status: ConnectionStatus, shown: boolean) {
  const state = store.getState();
  if (status !== "connected") {
    if (state.phase !== "closed") state.disconnect();
  } else if (shown) {
    void state.connect();
  }
}
