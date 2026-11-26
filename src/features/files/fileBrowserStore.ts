import { createStore, type StoreApi } from "zustand/vanilla";
import type { ConnectionStatus } from "@/features/workspace/tabs";
import { readCommandError, type CommandError } from "@/lib/ipc/connect";
import { maxEditSize } from "@/lib/ipc/edit";
import * as ipc from "@/lib/ipc/files";
import type { FileEntry, FsId } from "@/lib/ipc/files";
import type { HostId } from "@/lib/ipc/hosts";
import { createSharedRemoteEdits, type EditCommands, type RemoteEditItem } from "./sharedRemoteEdits";
import { childPath, isDirLike, isFileLike, parentPath } from "./fileList";

/** The SFTP, file operation and remote edit commands a File panel uses (`@/lib/ipc/files`, `@/lib/ipc/edit`); a fake in tests. */
export type FilesApi = Pick<
  typeof ipc,
  "openFiles" | "listFiles" | "closeFiles" | "createDir" | "renameFile" | "countFiles" | "deleteFiles" | "chmodFile"
> & EditCommands;

/**
 * A file `open` did not open in the editor without asking: over the size limit (offer a download)
 * or binary-looking (offer to open anyway, or download).
 */
export interface EditQuestion {
  path: string;
  name: string;
  reason: "tooLarge" | "binary";
}

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
  /** Enters a directory (or a link to one); opens a file (or a link to one) in the user's editor. */
  open(entry: FileEntry): Promise<void>;
  /** Files opened in the user's editor, uploaded on every save; oldest first. */
  edits: RemoteEditItem[];
  /** A file `open` asks about before editing it; the dialog may download it instead. */
  editQuestion: EditQuestion | null;
  /** `open` edits the asked-about file even though it looks binary; `cancel` drops the question. */
  answerEditQuestion(answer: "open" | "cancel"): Promise<void>;
  /** Uploads a failed edit again, or opens again one that could not be opened. */
  retryEdit(path: string): Promise<void>;
  /** Releases this pane’s edit. Its last pane stops uploads and deletes the temp copy. */
  closeEdit(path: string): void;
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
  /** Closes the SFTP session (the Connection dropped, or the pane closed); keeps the path for `connect`. Edits stay open. */
  disconnect(): void;
  /** The pane closed: disconnects and closes every edit. */
  dispose(): void;
}

const notOpen: CommandError = { kind: "notOpen", message: "the File panel is not open" };

/**
 * One File panel's state: the SFTP session over its Host's Connection, the directory shown
 * and the selection. Actions never reject; failures land in `error`.
 */
/** `startPath` is where it opens the first time (the Host's default directory); home if absent or gone. */
export function createFileBrowserStore(
  api: FilesApi,
  hostId: HostId,
  startPath?: string | null,
  local?: { openPath(path: string): Promise<void>; windows: boolean },
  editsForPanel = createSharedRemoteEdits(api),
): StoreApi<FileBrowserState> {
  let fsId: FsId | null = null;
  let opening: Promise<void> | null = null;
  /** Bumped by `disconnect`, so an open that finishes afterwards is closed again. */
  let openGeneration = 0;
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

    const remoteEdits = editsForPanel(hostId, (item) => {
      const { path, name, error } = item;
      const edits = get().edits;
      if (item.status === "openFailed" && (error?.kind === "tooLarge" || error?.kind === "binary")) {
        remoteEdits.release(path);
        set({ edits: edits.filter((e) => e.path !== path), editQuestion: { path, name, reason: error.kind } });
      } else {
        const next = edits.slice();
        const index = next.findIndex((edit) => edit.path === path);
        if (index === -1) next.push(item);
        else next[index] = item;
        set({ edits: next });
      }
    });

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

    const invalidName = (name: string): CommandError | null =>
      local?.windows && (
        /[\\:<>|?*"]/.test(name) ||
        /[. ]$/.test(name) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?: *\.|$)/i.test(name)
      )
        ? { kind: "invalidName", message: name }
        : null;

    return {
      phase: "closed",
      edits: [],
      editQuestion: null,
      path: null,
      entries: [],
      loading: false,
      error: null,
      selection: new Set(),

      connect() {
        if (get().phase === "open") return Promise.resolve();
        opening ??= (async () => {
          const mine = openGeneration;
          set({ phase: "opening", error: null });
          try {
            const id = await api.openFiles(hostId);
            if (mine !== openGeneration) {
              void api.closeFiles(id).catch(() => {});
              return;
            }
            fsId = id;
            set({ phase: "open" });
            const first = get().path === null;
            await list(get().path ?? startPath ?? "", true);
            const missing = get().error?.kind === "notFound" || get().error?.kind === "notADirectory";
            if (mine === openGeneration && ((first && startPath && get().path === null) || (!first && missing))) {
              await list("", true);
            }
          } catch (e) {
            if (mine === openGeneration) set({ phase: "closed", error: readCommandError(e) });
          } finally {
            if (mine === openGeneration) opening = null;
          }
        })();
        return opening;
      },

      navigate: (path) => list(path, false),
      up: () => {
        const path = get().path ?? "/";
        return list(local ? childPath(path, "..") : parentPath(path), false);
      },
      refresh: () => list(get().path ?? "", true),
      async open(entry) {
        const dir = get().path;
        if (dir === null) return;
        const path = childPath(dir, entry.name);
        if (isDirLike(entry)) await list(path, false);
        else if (local && isFileLike(entry)) {
          try {
            await local.openPath(path);
          } catch (e) {
            if (get().path === dir) set({ error: readCommandError(e) });
          }
        } else if (entry.kind === "file" && entry.size > maxEditSize && !remoteEdits.isOpen(path)) {
          set({ editQuestion: { path, name: entry.name, reason: "tooLarge" } });
        } else if (isFileLike(entry)) await remoteEdits.open(path);
      },

      async answerEditQuestion(answer) {
        const question = get().editQuestion;
        set({ editQuestion: null });
        if (answer === "open" && question?.reason === "binary") await remoteEdits.open(question.path, true);
      },

      retryEdit: remoteEdits.retry,
      closeEdit(path) {
        remoteEdits.release(path);
        set({ edits: get().edits.filter((e) => e.path !== path) });
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

      createFolder: async (name) => invalidName(name) ?? operate((id, dir) => api.createDir(id, childPath(dir, name)), name),
      rename: async (name, newName) =>
        invalidName(newName) ?? operate((id, dir) => api.renameFile(id, childPath(dir, name), childPath(dir, newName)), newName),
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
        openGeneration += 1;
        request += 1;
        opening = null;
        if (fsId !== null) void api.closeFiles(fsId).catch(() => {});
        fsId = null;
        set({ phase: "closed", loading: false });
      },

      dispose() {
        get().disconnect();
        for (const edit of get().edits) get().closeEdit(edit.path);
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
