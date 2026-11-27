import { createStore, type StoreApi } from "zustand/vanilla";
import type { ConnectionStatus } from "@/features/workspace/tabs";
import { readCommandError, type CommandError } from "@/lib/ipc/connect";
import { maxEditSize } from "@/lib/ipc/edit";
import * as ipc from "@/lib/ipc/files";
import type { FileEntry, FilePromise, FsId, NameMatch, NameSearchMode, NameSearchResult, PermissionChange } from "@/lib/ipc/files";
import type { HostId } from "@/lib/ipc/hosts";
import { createSharedRemoteEdits, type EditCommands, type RemoteEditItem } from "./sharedRemoteEdits";
import { archiveFolderName, childPath, isDirLike, isFileLike, parentPath } from "./fileList";

/** The SFTP, file operation and remote edit commands a File panel uses (`@/lib/ipc/files`, `@/lib/ipc/edit`); a fake in tests. */
export type FilesApi = Pick<
  typeof ipc,
  "openFiles" | "listFiles" | "closeFiles" | "createDir" | "createEmptyFile" | "renameFile" | "countFiles" | "deleteFiles" | "chmodFile"
  | "folderSize" | "searchNames" | "compressFiles" | "extractArchive"
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

/** Entries captured in one directory for a cut or a drag. */
export interface FileMove {
  directory: string;
  names: readonly string[];
}

export interface MoveFailure {
  name: string;
  error: CommandError;
}

export type FolderSize =
  | { state: "calculating" }
  | { state: "complete"; bytes: number }
  | { state: "failed"; error: CommandError };

export type NameSearch =
  | { state: "running" | "cancelled" }
  | { state: "complete"; result: NameSearchResult }
  | { state: "failed"; error: CommandError };

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
  filePromise(directory: string, names: readonly string[]): FilePromise | null;

  /** Opens an SFTP session on the Host's live Connection, then lists where it was (first time: home). */
  connect(): Promise<void>;
  /** Shows `path`: absolute, `~`, `~/x`, or relative to home. */
  navigate(path: string, source?: "user" | "terminal"): Promise<void>;
  canGoBack: boolean;
  canGoForward: boolean;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
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
  // why it failed (`null` on success). Failures leave the listing’s `error` alone.
  /** Creates the folder `name` and selects it. */
  createFolder(name: string): Promise<CommandError | null>;
  /** Creates the empty file `name` without replacing an entry and selects it. */
  createFile(name: string): Promise<CommandError | null>;
  /** Renames `name` to `newName` (never over an existing entry) and selects it. */
  rename(name: string, newName: string): Promise<CommandError | null>;
  /** Packs selected entries into a new tar.gz in the directory where the dialog opened. */
  compress(directory: string, names: readonly string[], archive: string): Promise<CommandError | null>;
  /** Expands a single archive into a new sibling folder. */
  extractArchive(directory: string, archive: string): Promise<CommandError | null>;
  /** This panel's cut entries, kept while browsing elsewhere on its Host. */
  cut: FileMove | null;
  moving: boolean;
  moveFailures: MoveFailure[];
  cutEntries(names: readonly string[]): void;
  clearCut(): void;
  /** Moves the cut entries into the current directory, keeping only failures available to retry. */
  pasteCutEntries(): Promise<MoveFailure[]>;
  /** Moves dragged entries into a folder in their listing. Other drop targets are ignored. */
  dropIntoFolder(source: FileMove, folder: string): Promise<MoveFailure[]>;
  clearMoveFailures(): void;
  /** Refreshes an affected directory when it is shown by this panel. */
  refreshAfterMove(directories: readonly string[]): Promise<void>;
  /** How many entries deleting `names` removes, folders' contents included. */
  countForDelete(names: readonly string[]): Promise<{ count: number } | { error: CommandError }>;
  /** Deletes `names`, folders with everything in them. */
  remove(names: readonly string[]): Promise<CommandError | null>;
  /** Edits permissions in the directory where the dialog opened. */
  setPermissions(directory: string, name: string, change: PermissionChange): Promise<CommandError | null>;
  /** On-demand folder sizes in the directory shown, keyed by entry name. */
  folderSizes: ReadonlyMap<string, FolderSize>;
  calculateFolderSize(name: string): Promise<void>;
  cancelFolderSize(name: string): void;
  search: NameSearch | null;
  searchNames(query: string, mode: NameSearchMode): Promise<void>;
  cancelSearch(): void;
  clearSearch(): void;
  /** The result selected by a search, including a hidden entry while it remains selected. */
  revealedName: string | null;
  revealSearchMatch(match: NameMatch): Promise<void>;
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
  refreshHostAfterMove?: (directories: readonly string[]) => Promise<void>,
  onNavigate?: (path: string) => void,
): StoreApi<FileBrowserState> {
  let fsId: FsId | null = null;
  let opening: Promise<void> | null = null;
  /** Bumped by `disconnect`, so an open that finishes afterwards is closed again. */
  let openGeneration = 0;
  /** Bumped by each listing request; only the latest one is shown. */
  let request = 0;
  let listingNavigation = false;
  const pendingMoveRefresh = new Set<string>();
  const folderSizeScans = new Map<string, AbortController>();
  let nameScan: AbortController | null = null;
  let anchor: string | null = null;
  /** Only successful listings enter history, using the canonical paths returned by the filesystem. */
  const history: string[] = [];
  let historyIndex = -1;

  return createStore<FileBrowserState>()((set, get) => {
    const stopFolderSize = (name: string) => {
      folderSizeScans.get(name)?.abort();
      folderSizeScans.delete(name);
    };

    const retainFolderSizes = (entries: FileEntry[]) => {
      const current = get().folderSizes;
      if (current.size === 0) return current;
      const folders = new Set(entries.filter(({ kind }) => kind === "dir").map(({ name }) => name));
      return new Map([...current].filter(([name]) => {
        if (folders.has(name)) return true;
        stopFolderSize(name);
        return false;
      }));
    };

    const showFolderSize = (name: string, size: FolderSize | null) => {
      const folderSizes = new Map(get().folderSizes);
      if (size === null) folderSizes.delete(name);
      else folderSizes.set(name, size);
      set({ folderSizes });
    };

    const stopSearch = () => {
      nameScan?.abort();
      nameScan = null;
    };

    const list = async (
      path: string,
      keepSelection: boolean,
      { targetIndex, preserveError = false, selectName, userNavigation = false }: {
        targetIndex?: number;
        preserveError?: boolean;
        selectName?: string;
        userNavigation?: boolean;
      } = {},
    ) => {
      if (fsId === null) return;
      const mine = ++request;
      listingNavigation = !keepSelection;
      if (listingNavigation) stopSearch();
      set({ loading: true, ...(listingNavigation ? { search: null } : {}) });
      try {
        const listing = await api.listFiles(fsId, path);
        if (mine !== request) return;
        const names = new Set(listing.entries.map((e) => e.name));
        const samePath = listing.path === get().path;
        const revealedName = selectName && names.has(selectName) ? selectName : null;
        const missingMatch = selectName !== undefined && revealedName === null;
        const selection = revealedName !== null
          ? new Set([revealedName])
          : keepSelection && samePath ? new Set([...get().selection].filter((n) => names.has(n))) : new Set<string>();
        if (revealedName !== null) anchor = revealedName;
        if (!selection.has(anchor ?? "")) anchor = null;
        if (targetIndex !== undefined) {
          historyIndex = targetIndex;
          history[historyIndex] = listing.path;
        } else if (!samePath) {
          historyIndex += 1;
          history.splice(historyIndex, history.length - historyIndex, listing.path);
        }
        set({
          path: listing.path,
          entries: listing.entries,
          folderSizes: retainFolderSizes(samePath ? listing.entries : []),
          selection,
          revealedName: revealedName ?? (keepSelection && samePath ? get().revealedName : null),
          loading: false,
          ...(preserveError ? {} : {
            error: missingMatch
              ? { kind: "notFound", message: "", details: { path: childPath(listing.path, selectName) } }
              : null,
          }),
          canGoBack: historyIndex > 0,
          canGoForward: historyIndex < history.length - 1,
        });
        if (userNavigation && !samePath && !missingMatch) onNavigate?.(listing.path);
      } catch (e) {
        if (mine !== request) return;
        set({ loading: false, ...(preserveError ? {} : { error: readCommandError(e) }) });
      } finally {
        if (mine === request && pendingMoveRefresh.size > 0) {
          const current = get().path;
          const refresh = current !== null && pendingMoveRefresh.has(current);
          pendingMoveRefresh.clear();
          if (refresh) await list(current, true, { preserveError: true });
        }
      }
    };

    const traverse = async (step: -1 | 1) => {
      const targetIndex = historyIndex + step;
      const target = history[targetIndex];
      if (target !== undefined) await list(target, false, { targetIndex, userNavigation: true });
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
      { select, directory }: { select?: string; directory?: string } = {},
    ): Promise<CommandError | null> => {
      const dir = directory ?? get().path;
      if (fsId === null || dir === null) return notOpen;
      const generation = openGeneration;
      let failure: CommandError | null = null;
      try {
        await run(fsId, dir);
      } catch (e) {
        failure = readCommandError(e);
      }
      // Leave a newer Connection or pending navigation in charge of the listing.
      const stillHere = () =>
        generation === openGeneration && get().path === dir && !(listingNavigation && get().loading);
      if (stillHere()) await list(dir, true, { preserveError: failure !== null });
      if (failure === null && select !== undefined && stillHere() && get().entries.some((e) => e.name === select)) {
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

    const move = async (source: FileMove, destination: string, folderLink = false): Promise<MoveFailure[]> => {
      const id = fsId;
      if (id === null || get().moving || source.names.length === 0) return [];
      const generation = openGeneration;
      set({ moving: true, moveFailures: [] });
      const failures: MoveFailure[] = [];
      for (const name of source.names) {
        const from = childPath(source.directory, name);
        try {
          if (generation !== openGeneration) throw notOpen;
          if (destination === from || destination.startsWith(childPath(from, ""))) {
            throw { kind: "moveIntoSelf", message: "cannot move an entry into itself" } satisfies CommandError;
          }
          await api.renameFile(id, from, childPath(destination, name));
        } catch (error) {
          failures.push({ name, error: readCommandError(error) });
        }
      }
      // Resolve folder links for refresh only. Rename must use the exact row path.
      const targetPath = folderLink && generation === openGeneration && destination === destination.trim()
        ? await api.listFiles(id, destination).then((listing) => listing.path, () => destination)
        : destination;
      const refresh = refreshHostAfterMove ?? get().refreshAfterMove;
      await refresh([source.directory, targetPath]);
      set({
        moving: false,
        moveFailures: failures,
        ...(get().cut === source
          ? { cut: failures.length ? { directory: source.directory, names: failures.map(({ name }) => name) } : null }
          : {}),
      });
      return failures;
    };

    return {
      phase: "closed",
      edits: [],
      editQuestion: null,
      path: null,
      entries: [],
      loading: false,
      error: null,
      selection: new Set(),
      canGoBack: false,
      canGoForward: false,
      cut: null,
      moving: false,
      moveFailures: [],
      folderSizes: new Map(),
      search: null,
      revealedName: null,

      filePromise(directory, names) {
        const { path, entries } = get();
        if (local || fsId === null || directory !== path || names.length !== 1) return null;
        const entry = entries.find(({ name }) => name === names[0]);
        if (entry?.kind !== "file") return null;
        return { id: fsId, directory, name: entry.name, size: entry.size, modified: entry.modified };
      },

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

      navigate: (path, source = "user") => list(path, false, { userNavigation: source === "user" }),
      goBack: () => traverse(-1),
      goForward: () => traverse(1),
      up: () => {
        const path = get().path ?? "/";
        return list(local ? childPath(path, "..") : parentPath(path), false, { userNavigation: true });
      },
      refresh: () => list(get().path ?? "", true),
      async open(entry) {
        const dir = get().path;
        if (dir === null) return;
        const path = childPath(dir, entry.name);
        if (isDirLike(entry)) await list(path, false, { userNavigation: true });
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

      createFolder: async (name) => invalidName(name) ?? operate((id, dir) => api.createDir(id, childPath(dir, name)), { select: name }),
      createFile: async (name) =>
        invalidName(name) ?? operate((id, dir) => api.createEmptyFile(id, childPath(dir, name)), { select: name }),
      rename: async (name, newName) =>
        invalidName(newName) ?? operate((id, dir) => api.renameFile(id, childPath(dir, name), childPath(dir, newName)), { select: newName }),
      compress: (directory, names, archive) =>
        operate((id, dir) => api.compressFiles(id, dir, names, archive), { directory, select: archive }),
      extractArchive: (directory, archive) =>
        operate((id, dir) => api.extractArchive(id, dir, archive), {
          directory,
          select: archiveFolderName(archive) ?? undefined,
        }),
      cutEntries(names) {
        const { path, moving } = get();
        if (fsId !== null && path !== null && !moving && names.length > 0) {
          set({ cut: { directory: path, names: [...names] } });
        }
      },
      clearCut: () => set({ cut: null }),
      async pasteCutEntries() {
        const { path, cut, moving } = get();
        if (fsId === null || path === null || cut === null || path === cut.directory || moving) return [];
        return move(cut, path);
      },
      async dropIntoFolder(source, folder) {
        const { path, entries } = get();
        if (path === null || path !== source.directory) return [];
        const entry = entries.find(({ name }) => name === folder);
        return entry && isDirLike(entry) ? move(source, childPath(path, folder), entry.kind === "symlink") : [];
      },
      clearMoveFailures: () => set({ moveFailures: [] }),
      async refreshAfterMove(directories) {
        if (fsId === null) return;
        const { path, loading } = get();
        if (loading && listingNavigation) {
          for (const directory of directories) pendingMoveRefresh.add(directory);
        } else if (path !== null && directories.includes(path)) {
          await list(path, true, { preserveError: true });
        }
      },
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
      setPermissions: (directory, name, change) =>
        operate((id, dir) => api.chmodFile(id, childPath(dir, name), change), { directory }),
      async calculateFolderSize(name) {
        const { path, entries } = get();
        const id = fsId;
        if (local || id === null || path === null || folderSizeScans.has(name) ||
          !entries.some((entry) => entry.name === name && entry.kind === "dir")) return;

        const scan = new AbortController();
        folderSizeScans.set(name, scan);
        showFolderSize(name, { state: "calculating" });
        let size: FolderSize | null;
        try {
          const bytes = await api.folderSize(id, childPath(path, name), scan.signal);
          size = bytes === null ? null : { state: "complete", bytes };
        } catch (error) {
          size = { state: "failed", error: readCommandError(error) };
        }
        if (scan.signal.aborted) return;
        folderSizeScans.delete(name);
        showFolderSize(name, size);
      },
      cancelFolderSize(name) {
        if (!folderSizeScans.has(name)) return;
        stopFolderSize(name);
        showFolderSize(name, null);
      },
      async searchNames(query, mode) {
        const { path, loading, phase } = get();
        const id = fsId;
        if (local || phase !== "open" || id === null || path === null || (loading && listingNavigation) || query === "") return;
        stopSearch();
        const scan = new AbortController();
        nameScan = scan;
        set({ search: { state: "running" } });
        let search: NameSearch;
        try {
          const result = await api.searchNames(id, path, query, mode, scan.signal);
          search = result ? { state: "complete", result } : { state: "cancelled" };
        } catch (error) {
          search = { state: "failed", error: readCommandError(error) };
        }
        if (nameScan === scan) {
          nameScan = null;
          set({ search });
        }
      },
      cancelSearch() {
        if (nameScan === null) return;
        stopSearch();
        set({ search: { state: "cancelled" } });
      },
      clearSearch() {
        stopSearch();
        if (get().search !== null) set({ search: null });
      },
      revealSearchMatch: ({ parent, name }) => list(parent, false, { selectName: name, userNavigation: true }),

      disconnect() {
        openGeneration += 1;
        request += 1;
        opening = null;
        pendingMoveRefresh.clear();
        stopSearch();
        const folderSizes = retainFolderSizes([]);
        if (fsId !== null) void api.closeFiles(fsId).catch(() => {});
        fsId = null;
        set({ phase: "closed", loading: false, folderSizes, search: null, revealedName: null });
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
