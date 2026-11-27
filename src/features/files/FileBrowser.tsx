import { DndContext, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Calculator,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  ClipboardPaste,
  Copy,
  Download,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FilePen,
  FilePlay,
  FilePlus,
  FileSymlink,
  FileText,
  Folder,
  FolderPlus,
  FolderSymlink,
  KeyRound,
  LoaderCircle,
  Pencil,
  Scissors,
  Trash2,
  Upload,
  Search,
  X,
} from "lucide-react";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/IconButton";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { currentPlatform, matchFileHistoryShortcut, matchFileMoveShortcut, shortcutLabel } from "@/features/workspace/shortcuts";
import type { CommandError } from "@/lib/ipc/connect";
import type { FileEntry } from "@/lib/ipc/files";
import { writeClipboardText } from "@/lib/ipc/system";
import { useSetting } from "@/lib/storage";
import { cn } from "@/lib/utils";
import type { FileBrowserStore } from "./fileBrowsers";
import type { FileMove, FolderSize, SelectMode } from "./fileBrowserStore";
import { errorText, operationErrorText } from "./fileErrors";
import { FileOperationDialog, MoveFailureDialog, type FileOperation } from "./FileOperationDialogs";
import { FileNameSearch } from "./FileNameSearch";
import { filesSetting } from "./file-prefs";
import {
  childPath,
  fileIconKind,
  formatPermissions,
  formatSize,
  isDirLike,
  isFileLike,
  nameProblem,
  shownEntries,
  visibleRows,
  type SortKey,
} from "./fileList";

/** Every row is this tall, so only the rows in view are rendered (directories may hold 10,000+ entries). */
const rowHeight = 26;
const overscan = 8;
/** Minimum widths in rem. The name column takes any extra space. */
const columnWidths: Record<SortKey, number> = { name: 6.5, size: 4.5, modified: 8, permissions: 6 };
const columnGrid = "grid grid-cols-(--file-columns)";

const entryIcons = {
  folder: { Icon: Folder, color: "text-ansi-blue-ink" },
  folderLink: { Icon: FolderSymlink, color: "text-ansi-cyan-ink" },
  fileLink: { Icon: FileSymlink, color: "text-ansi-cyan-ink" },
  archive: { Icon: FileArchive, color: "text-ansi-yellow-ink" },
  image: { Icon: FileImage, color: "text-ansi-magenta-ink" },
  code: { Icon: FileCode, color: "text-ansi-green-ink" },
  media: { Icon: FilePlay, color: "text-ansi-red-ink" },
  document: { Icon: FileText, color: "text-muted-foreground" },
  file: { Icon: File, color: "text-muted-foreground" },
};

export interface FileExchange {
  side: "local" | "remote";
  copy?(paths: string[]): void;
}

/**
 * The path bar and the file table of one File panel. `onDownload` downloads the named
 * entries of the current folder (the row's context menu offers it for the selection).
 */
export function FileBrowser({
  store,
  hostName,
  onDownload,
  exchange,
  enableMove = false,
}: {
  store: FileBrowserStore;
  hostName: string;
  onDownload?(names: string[]): void;
  exchange?: FileExchange;
  enableMove?: boolean;
}) {
  const { t } = useTranslation();
  const path = useStore(store, (s) => s.path);
  const error = useStore(store, (s) => s.error);
  const canPaste = useStore(store, (s) => s.cut !== null && s.cut.directory !== s.path && !s.moving);
  const [operation, setOperation] = useState<FileOperation | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const moveFailures = useStore(store, (s) => s.moveFailures);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const panel = useRef<HTMLDivElement>(null);
  const dragged = useRef<FileMove | undefined>(undefined);
  const focusPanel = () => panel.current?.focus({ preventScroll: true });
  const toggleSearch = exchange?.side === "local" ? undefined : () => {
    if (searchOpen) focusPanel();
    setSearchOpen(!searchOpen);
  };
  const paste = enableMove && canPaste ? () => void store.getState().pasteCutEntries() : undefined;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (event.defaultPrevented || event.nativeEvent.isComposing || !(target instanceof Element) ||
      !event.currentTarget.contains(target) || target.closest("input, textarea, select, [contenteditable]")) return;
    if (paste && matchFileMoveShortcut(event, currentPlatform()) === "filePaste") {
      event.preventDefault();
      if (!event.repeat) paste();
      return;
    }
    const command = matchFileHistoryShortcut(event);
    if (!command) return;
    event.preventDefault();
    const state = store.getState();
    if (command === "fileBack" ? !state.canGoBack : !state.canGoForward) return;
    // The path bar and table remount on navigation. Keep focus inside the panel.
    focusPanel();
    void (command === "fileBack" ? state.goBack() : state.goForward());
  };
  const browser = (
    <div ref={panel} tabIndex={-1} onKeyDown={onKeyDown}
      className="focus-visible:ring-ring/50 flex h-full flex-col outline-none focus-visible:ring-[3px] focus-visible:ring-inset">
      {/* Sibling keys must differ: PathBar and FileTable sharing the path as key made React keep the old path bar. */}
      <PathBar key={`path:${path ?? ""}`} store={store} focusPanel={focusPanel} onOperation={setOperation}
        searchOpen={searchOpen} onToggleSearch={toggleSearch} />
      {error && path !== null && (
        <p role="alert" className="text-destructive px-3 pb-1.5 text-xs">
          {errorText(t, error, hostName)}
        </p>
      )}
      {/* Keyed by path: a new directory starts scrolled to the top with nothing focused. */}
      {path !== null && (searchOpen ? (
        <FileNameSearch store={store} path={path}
          onClose={() => {
            focusPanel();
            setSearchOpen(false);
          }} />
      ) : (
        <FileTable key={`table:${path}`} store={store} path={path}
          onOperation={setOperation} onDownload={onDownload} exchange={exchange}
          enableMove={enableMove} onPaste={paste} />
      ))}
      {operation && (
        <FileOperationDialog
          store={store}
          operation={operation}
          remote={exchange?.side !== "local"}
          onClose={() => setOperation(null)}
        />
      )}
      {enableMove && moveFailures.length > 0 && (
        <MoveFailureDialog failures={moveFailures} onClose={store.getState().clearMoveFailures} />
      )}
    </div>
  );
  if (!enableMove) return browser;
  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin}
      onDragStart={({ active }) => {
        // The source row may scroll out of the virtualized list before the drop.
        dragged.current = active.data.current?.move as FileMove | undefined;
      }}
      onDragCancel={() => { dragged.current = undefined; }}
      onDragEnd={({ over }) => {
        const source = dragged.current;
        dragged.current = undefined;
        const folder = over?.data.current?.folder as string | undefined;
        if (source && folder !== undefined) void store.getState().dropIntoFolder(source, folder);
      }}
    >
      {browser}
    </DndContext>
  );
}

/** Split a canonical listing path, keeping POSIX, Windows drive and UNC roots as one segment. */
function pathCrumbs(path: string) {
  const root = path.match(/^(?:\/\/(?:\?\/UNC\/)?[^/]+\/[^/]+\/?|[a-z]:\/|\/)/i)?.[0] ?? "";
  const crumbs = root ? [{ name: root, path: root }] : [];
  let prefix = root;
  for (const name of path.slice(root.length).split("/").filter(Boolean)) {
    prefix = prefix ? childPath(prefix, name) : name;
    crumbs.push({ name, path: prefix });
  }
  return crumbs;
}

function PathBar({ store, focusPanel, onOperation, searchOpen, onToggleSearch }: {
  store: FileBrowserStore;
  focusPanel(): void;
  onOperation(operation: FileOperation): void;
  searchOpen: boolean;
  onToggleSearch?: () => void;
}) {
  const { t } = useTranslation();
  const path = useStore(store, (s) => s.path);
  const canGoBack = useStore(store, (s) => s.canGoBack);
  const canGoForward = useStore(store, (s) => s.canGoForward);
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const breadcrumb = useRef<HTMLElement>(null);
  const editing = draft !== null;
  const crumbs = path !== null && !editing ? pathCrumbs(path) : [];
  const platform = currentPlatform();

  useLayoutEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    } else if (breadcrumb.current) {
      breadcrumb.current.scrollLeft = breadcrumb.current.scrollWidth;
    }
  }, [editing]);

  const navigate = (run: () => Promise<void>) => {
    focusPanel();
    void run();
  };

  return (
    <form
      className="flex shrink-0 items-center gap-1 p-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!draft?.trim()) return;
        const editor = input.current;
        await store.getState().navigate(draft.trim());
        const { error, loading } = store.getState();
        if (error || loading) return;
        if (document.activeElement === editor || (!editor?.isConnected && document.activeElement === document.body)) {
          focusPanel();
        }
        setDraft(null);
      }}
    >
      <div className="flex items-center">
        <IconButton
          type="button" label={t("files.back")} shortcut={shortcutLabel("fileBack", platform)}
          aria-keyshortcuts="Alt+ArrowLeft" className="size-6" disabled={!canGoBack}
          onClick={() => navigate(store.getState().goBack)}
        >
          <ArrowLeft />
        </IconButton>
        <IconButton
          type="button" label={t("files.forward")} shortcut={shortcutLabel("fileForward", platform)}
          aria-keyshortcuts="Alt+ArrowRight" className="size-6" disabled={!canGoForward}
          onClick={() => navigate(store.getState().goForward)}
        >
          <ArrowRight />
        </IconButton>
        <IconButton type="button" label={t("files.up")} className="size-6"
          disabled={path === null || path === "/"}
          onClick={() => navigate(store.getState().up)}
        >
          <ArrowUp />
        </IconButton>
      </div>
      <div className={cn("bg-muted flex h-7 min-w-0 flex-1 items-center rounded-lg px-0.5",
        editing && "focus-within:ring-ring/50 focus-within:ring-[3px]")}
        onBlur={(event) => {
          if (editing && !event.currentTarget.contains(event.relatedTarget)) setDraft(null);
        }}
      >
        {editing ? (
          <>
            <input ref={input} aria-label={t("files.path")} value={draft}
              spellCheck={false} autoCapitalize="off" autoCorrect="off"
              className="min-w-0 flex-1 bg-transparent px-1 font-mono text-xs outline-none"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  focusPanel();
                  setDraft(null);
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <IconButton type="submit" label={t("files.goToPath")} className="size-6"
              disabled={!draft.trim()} onPointerDown={(event) => event.preventDefault()}>
              <ArrowRight />
            </IconButton>
          </>
        ) : (
          <>
            <nav ref={breadcrumb} aria-label={t("files.path")} className="min-w-0 overflow-x-auto [scrollbar-width:none]">
              <ol className="flex w-max items-center">
                {crumbs.map((crumb, index) => (
                  <li key={crumb.path} className="flex items-center">
                    {index > 0 && <ChevronRight aria-hidden="true" className="text-muted-foreground size-3" />}
                    <Button type="button" variant="ghost" size="xs" title={crumb.path}
                      aria-current={index === crumbs.length - 1 ? "location" : undefined}
                      className="text-muted-foreground aria-[current=location]:text-foreground max-w-36 px-1 font-mono focus-visible:ring-inset"
                      onClick={() => navigate(() => store.getState().navigate(crumb.path))}
                    >
                      <span className="truncate">{crumb.name}</span>
                    </Button>
                  </li>
                ))}
              </ol>
            </nav>
            <IconButton type="button" label={t("files.editPath")} className="h-6 min-w-6 flex-1 cursor-text justify-end px-1"
              disabled={path === null} onClick={() => setDraft(path)}>
              <Pencil className="size-3" />
            </IconButton>
          </>
        )}
      </div>
      {onToggleSearch && (
        <IconButton type="button" label={t("files.search.open")} className="size-6"
          aria-pressed={searchOpen} disabled={path === null} onClick={onToggleSearch}>
          <Search />
        </IconButton>
      )}
      <IconButton
        type="button"
        label={t("files.newFile")}
        disabled={path === null}
        onClick={() => onOperation({ kind: "newFile" })}
      >
        <FilePlus />
      </IconButton>
      <IconButton
        type="button"
        label={t("files.newFolder")}
        disabled={path === null}
        onClick={() => onOperation({ kind: "newFolder" })}
      >
        <FolderPlus />
      </IconButton>
      <IconButton
        type="button"
        label={t("files.copyPath")}
        disabled={path === null}
        onClick={() => path !== null && void writeClipboardText(path)}
      >
        <Copy />
      </IconButton>
    </form>
  );
}

function FileTable({
  store,
  path,
  onOperation,
  onDownload,
  exchange,
  enableMove,
  onPaste,
}: {
  store: FileBrowserStore;
  path: string;
  onOperation(operation: FileOperation): void;
  onDownload?(names: string[]): void;
  exchange?: FileExchange;
  enableMove: boolean;
  onPaste?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const entries = useStore(store, (s) => s.entries);
  const selection = useStore(store, (s) => s.selection);
  const loading = useStore(store, (s) => s.loading);
  const cut = useStore(store, (s) => s.cut);
  const moving = useStore(store, (s) => s.moving);
  const folderSizes = useStore(store, (s) => s.folderSizes);
  const revealed = useStore(store, (s) =>
    s.revealedName !== null && s.selection.has(s.revealedName) ? s.revealedName : null);
  const canStartMove = enableMove && !moving;
  const [prefs, setPrefs] = useSetting(filesSetting);
  const [filter, setFilter] = useState("");
  const columns: SortKey[] = ["name", "size"];
  if (prefs.showModified) columns.push("modified");
  if (prefs.showPermissions) columns.push("permissions");
  const sort = columns.includes(prefs.sort.key) ? prefs.sort : filesSetting.defaults.sort;
  const minWidth = columns.reduce((total, key) => total + columnWidths[key], 1.5);
  const gridTemplate = columns.map((key) => key === "name"
    ? `minmax(${columnWidths.name}rem, 1fr)`
    : `${columnWidths[key]}rem`).join(" ");
  const rows = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    const shown = shownEntries(entries, sort, prefs.showHidden, revealed);
    return query ? shown.filter((entry) => entry.name.toLocaleLowerCase().includes(query)) : shown;
  }, [entries, sort, prefs.showHidden, filter, revealed]);
  const order = useMemo(() => rows.map((r) => r.name), [rows]);
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }),
    [i18n.language],
  );

  const grid = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setViewport(Math.max(0, element.clientHeight - (header.current?.offsetHeight ?? 0)));
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  const [focused, setFocused] = useState<string | null>(null);
  const [rename, setRename] = useState<{
    name: string;
    value: string;
    busy: boolean;
    failure: CommandError | null;
  } | null>(null);
  const focusName = focused ?? revealed;
  const focusIndex = focusName === null ? -1 : order.indexOf(focusName);
  const revealedIndex = revealed === null ? -1 : order.indexOf(revealed);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || revealedIndex < 0) return;
    const top = revealedIndex * rowHeight;
    const height = element.clientHeight - (header.current?.offsetHeight ?? 0);
    if (top < element.scrollTop || top + rowHeight > element.scrollTop + height) {
      element.scrollTop = top;
    }
    grid.current?.focus({ preventScroll: true });
  }, [revealedIndex, revealed]);
  const { start, end } = visibleRows({ scrollTop, viewport, rowHeight, count: rows.length, overscan });
  const baseId = useId();
  const rowId = (index: number) => `${baseId}-row-${index}`;
  const renameErrorId = `${baseId}-rename-error`;
  const renameProblem = rename && nameProblem(rename.value, entries.map((entry) => entry.name), rename.name);
  const renameError = rename?.failure
    ? operationErrorText(t, rename.failure)
    : rename && renameProblem && renameProblem !== "empty"
      ? t(`files.nameProblem.${renameProblem}`, { name: rename.value })
      : null;

  // Keep the focused input mounted when scrolling moves its row outside the virtual window.
  const renameIndex = rename ? order.indexOf(rename.name) : -1;
  const visibleIndexes = Array.from({ length: end - start }, (_, offset) => start + offset);
  if (renameIndex >= 0 && renameIndex < start) visibleIndexes.unshift(renameIndex);
  if (renameIndex >= end) visibleIndexes.push(renameIndex);

  const select = (name: string, mode: SelectMode) => {
    setFocused(name);
    store.getState().select(name, mode, order);
  };
  const reveal = (index: number) => {
    const element = scroller.current;
    if (!element) return;
    const top = index * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + viewport)
      element.scrollTop = top + rowHeight - viewport;
  };
  const beginRename = (name: string, index: number) => {
    if (rename?.busy) return;
    setFocused(name);
    setRename({ name, value: name, busy: false, failure: null });
    reveal(index);
  };
  const onRenameKeyDown = async (event: KeyboardEvent<HTMLInputElement>) => {
    if (!rename || event.nativeEvent.isComposing || (event.key !== "Enter" && event.key !== "Escape")) return;
    event.preventDefault();
    event.stopPropagation();
    if (rename.busy) return;
    const input = event.currentTarget;
    const close = (name: string) => {
      if (document.activeElement === input || (!input.isConnected && document.activeElement === document.body)) {
        grid.current?.focus({ preventScroll: true });
      }
      setFocused(name);
      setRename(null);
    };
    if (event.key === "Escape") {
      close(rename.name);
      return;
    }
    if (renameProblem) return;
    if (rename.name === rename.value) {
      close(rename.name);
      return;
    }
    setRename({ ...rename, busy: true, failure: null });
    const failure = await store.getState().rename(rename.name, rename.value);
    if (failure) setRename({ ...rename, busy: false, failure });
    else close(rename.value);
  };

  const sortBy = (key: SortKey) => {
    const direction = sort.key === key && sort.direction === "asc" ? "desc" : "asc";
    setPrefs({ ...prefs, sort: { key, direction } });
  };

  /** The visible selection in display order, for row actions and the footer. */
  const selected = useMemo(() => order.filter((name) => selection.has(name)), [order, selection]);
  const hiddenSelected = selection.size - selected.length;
  const cutNames = useMemo(() => new Set(cut?.directory === path ? cut.names : []), [cut, path]);
  const askDelete = () => {
    const names = selected;
    if (names.length > 0) onOperation({ kind: "delete", names });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
    if (canStartMove && selected.length > 0 && matchFileMoveShortcut(event, currentPlatform()) === "fileCut") {
      event.preventDefault();
      store.getState().cutEntries(selected);
      return;
    }
    const move = (to: number) => {
      const index = Math.max(0, Math.min(rows.length - 1, to));
      const row = rows[index];
      if (!row) return;
      event.preventDefault();
      select(row.name, event.shiftKey ? "range" : "only");
      reveal(index);
    };
    const page = Math.max(1, Math.floor(viewport / rowHeight) - 1);
    switch (event.key) {
      case "ArrowDown":
        return move(focusIndex + 1);
      case "ArrowUp":
        return move(focusIndex < 0 ? 0 : focusIndex - 1);
      case "PageDown":
        return move(focusIndex + page);
      case "PageUp":
        return move(focusIndex - page);
      case "Home":
        return move(0);
      case "End":
        return move(rows.length - 1);
      case "Enter": {
        const row = rows[focusIndex];
        if (row) {
          event.preventDefault();
          void store.getState().open(row);
        }
        return;
      }
      case "F2": {
        const row = rows[focusIndex];
        if (row) {
          event.preventDefault();
          beginRename(row.name, focusIndex);
        }
        return;
      }
      case "Delete":
        event.preventDefault();
        askDelete();
        return;
      case "Backspace":
        event.preventDefault();
        // Cmd+Backspace deletes, as in Finder; plain Backspace goes up.
        if (event.metaKey) askDelete();
        else void store.getState().up();
        return;
    }
  };

  return (
    <>
      {exchange && (
        <div className="relative mx-2 mb-2">
          <Search className="text-muted-foreground pointer-events-none absolute top-2 left-2 size-3.5" aria-hidden />
          <Input type="search" aria-label={t("sftp.filter")} placeholder={t("sftp.filter")}
            value={filter} className="h-7 pl-7 text-xs" onChange={(event) => {
              setFilter(event.target.value);
              setScrollTop(0);
              if (scroller.current) scroller.current.scrollTop = 0;
            }} />
        </div>
      )}
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={!onPaste}>
          <div
            ref={grid}
            role="grid"
            aria-label={t("files.listLabel", { path })}
            aria-rowcount={rows.length + 1}
            aria-multiselectable
            aria-busy={loading || moving}
            aria-activedescendant={focusIndex >= 0 ? rowId(focusIndex) : undefined}
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="focus-visible:ring-ring/50 isolate flex min-h-0 flex-1 flex-col text-[12.5px] outline-none focus-visible:ring-[3px] focus-visible:ring-inset"
          >
            <div
              ref={scroller}
              className="min-h-0 flex-1 overflow-auto"
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            >
              <div style={{ minWidth: `${minWidth}rem`, "--file-columns": gridTemplate } as CSSProperties}>
                <div ref={header} role="row" aria-rowindex={1}
                  className={cn(columnGrid, "bg-surface sticky top-0 z-10 h-6 items-center px-3 pb-1")}
                >
                  {columns.map((key) => (
                    <HeaderCell key={key} label={t(`files.columns.${key}`)} sortKey={key}
                      sort={sort} onSort={sortBy} end={key === "size"} />
                  ))}
                </div>
                <div className={cn("px-2 pb-2", loading && "opacity-70")}>
                  {rows.length === 0 ? (
                    <p className="text-muted-foreground p-6 text-center">{filter.trim() ? t("sftp.noMatches") : t("files.emptyFolder")}</p>
                  ) : (
                    <div role="rowgroup" className="relative" style={{ height: rows.length * rowHeight }}>
                      {visibleIndexes.map((index) => {
                        const entry = rows[index]!;
                        const names = selection.has(entry.name) ? selected : [entry.name];
                        const paths = exchange?.copy ? names.map((name) => childPath(path, name)) : undefined;
                        return (
                          <FileRow
                            key={entry.name}
                            id={rowId(index)}
                            index={index}
                            entry={entry}
                            path={path}
                            exchange={exchange}
                            dragPaths={paths}
                            move={canStartMove ? { directory: path, names } : undefined}
                            cut={cutNames.has(entry.name)}
                            onCut={canStartMove ? () => store.getState().cutEntries(names) : undefined}
                            onPaste={onPaste}
                            onCopy={paths && (() => exchange?.copy?.(paths))}
                            selected={selection.has(entry.name)}
                            focused={index === focusIndex}
                            nameEditor={rename?.name === entry.name ? (
                              <Input
                                aria-label={t("files.rename.title", { name: entry.name })}
                                aria-describedby={renameError ? renameErrorId : undefined}
                                aria-invalid={!!renameError || undefined}
                                className="bg-surface h-5 rounded-sm px-1 py-0 text-[12.5px] md:text-[12.5px]"
                                autoFocus
                                autoCapitalize="off"
                                autoCorrect="off"
                                spellCheck={false}
                                readOnly={rename.busy}
                                value={rename.value}
                                onFocus={(event) => {
                                  const dot = entry.name.lastIndexOf(".");
                                  event.target.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
                                }}
                                onChange={(event) => setRename({ ...rename, value: event.target.value, failure: null })}
                                onKeyDown={onRenameKeyDown}
                                onClick={(event) => event.stopPropagation()}
                                onDoubleClick={(event) => event.stopPropagation()}
                                onContextMenu={(event) => event.stopPropagation()}
                              />
                            ) : undefined}
                            modified={prefs.showModified ? (entry.modified === null ? "" : dateFormat.format(entry.modified * 1000)) : undefined}
                            showPermissions={prefs.showPermissions}
                            onClick={(event) => select(entry.name, clickMode(event))}
                            onOpen={() => void store.getState().open(entry)}
                            onContextMenu={() => {
                              if (!selection.has(entry.name)) select(entry.name, "only");
                            }}
                            onOperation={(kind) => {
                              if (kind === "rename") beginRename(entry.name, index);
                              else if (kind === "permissions") onOperation({ kind, entry, directory: path });
                              else if (kind === "newFolder" || kind === "newFile") onOperation({ kind });
                              else onOperation({ kind, names });
                            }}
                            onDownload={onDownload && (() => onDownload(names))}
                            folderSize={entry.kind === "dir" && exchange?.side !== "local" ? {
                              current: folderSizes.get(entry.name),
                              calculate: () => void store.getState().calculateFolderSize(entry.name),
                              cancel: () => {
                                grid.current?.focus({ preventScroll: true });
                                store.getState().cancelFolderSize(entry.name);
                              },
                            } : undefined}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </ContextMenuTrigger>
        {onPaste && <ContextMenuContent><PasteItem onPaste={onPaste} /></ContextMenuContent>}
      </ContextMenu>
      {renameError && (
        <p id={renameErrorId} role="alert" className="text-destructive shrink-0 px-3 pb-1 text-xs">
          {renameError}
        </p>
      )}
      <div role="status" className="text-muted-foreground flex shrink-0 flex-wrap gap-x-3 gap-y-0.5 border-t px-3 py-1 text-xs tabular-nums">
        <span>{t("files.entryCount", { count: rows.length })}</span>
        <span>{t("files.selectedCount", { count: selected.length })}</span>
        {hiddenSelected > 0 && <span>{t("files.hiddenSelectedCount", { count: hiddenSelected })}</span>}
        {moving && <span>{t("files.move.moving")}</span>}
      </div>
    </>
  );
}

function clickMode(event: MouseEvent): SelectMode {
  if (event.shiftKey) return "range";
  if (event.metaKey || event.ctrlKey) return "toggle";
  return "only";
}

function HeaderCell({
  label,
  sortKey,
  sort,
  onSort,
  end = false,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; direction: "asc" | "desc" };
  onSort(key: SortKey): void;
  end?: boolean;
}) {
  const active = sort.key === sortKey;
  const Arrow = sort.direction === "asc" ? ChevronUp : ChevronDown;
  return (
    <div
      role="columnheader"
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      className={cn("flex min-w-0", end && "justify-end")}
    >
      <button
        type="button"
        className={cn(
          "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-w-0 items-center gap-0.5 rounded-sm px-1 text-xs font-medium outline-none focus-visible:ring-[3px]",
          active && "text-foreground",
        )}
        onClick={() => onSort(sortKey)}
      >
        <span className="truncate">{label}</span>
        {active && <Arrow className="size-3 shrink-0" aria-hidden />}
      </button>
    </div>
  );
}

function FileRow({
  id,
  index,
  entry,
  path,
  selected,
  focused,
  nameEditor,
  modified,
  showPermissions,
  onClick,
  onOpen,
  onContextMenu,
  onOperation,
  onDownload,
  exchange,
  dragPaths,
  onCopy,
  move,
  cut,
  onCut,
  onPaste,
  folderSize,
}: {
  id: string;
  index: number;
  entry: FileEntry;
  path: string;
  selected: boolean;
  focused: boolean;
  nameEditor?: ReactNode;
  modified?: string;
  showPermissions: boolean;
  onClick(event: MouseEvent): void;
  onOpen(): void;
  onContextMenu(): void;
  onOperation(kind: FileOperation["kind"] | "rename"): void;
  onDownload?: () => void;
  exchange?: FileExchange;
  dragPaths?: string[];
  onCopy?: () => void;
  move?: FileMove;
  cut: boolean;
  onCut?: () => void;
  onPaste?: () => void;
  folderSize?: { current?: FolderSize; calculate(): void; cancel(): void };
}) {
  const { t } = useTranslation();
  const renameOnMenuClose = useRef(false);
  const dir = isDirLike(entry);
  const { setNodeRef: setDragRef, listeners, isDragging } = useDraggable({
    id, disabled: (!dragPaths && !move) || !!nameEditor, data: { side: exchange?.side, paths: dragPaths, move },
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id, disabled: !move || !dir || !!nameEditor, data: { folder: entry.name },
  });
  const setNodeRef = useCallback((node: HTMLElement | null) => {
    setDragRef(node);
    setDropRef(node);
  }, [setDragRef, setDropRef]);
  const { Icon, color } = entryIcons[fileIconKind(entry)];
  const size = folderSize?.current;
  const sizeError = size?.state === "failed" ? operationErrorText(t, size.error) : undefined;
  const cancelSize = t("files.folderSize.cancel", { name: entry.name });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          {...listeners}
          id={id}
          role="row"
          aria-rowindex={index + 2}
          aria-selected={selected}
          className={cn(
            columnGrid,
            "absolute inset-x-0 items-center rounded-sm px-1 select-none",
            selected ? "bg-selected" : "hover:bg-accent/60",
            (isDragging || cut) && "opacity-50",
            isOver && "bg-selected ring-ring ring-2 ring-inset",
            focused && "ring-ring/40 ring-1 ring-inset",
          )}
          style={{ top: index * rowHeight, height: rowHeight }}
          onClick={onClick}
          onDoubleClick={onOpen}
          onContextMenu={onContextMenu}
        >
          <div role="gridcell" className="flex min-w-0 items-center gap-1.5 px-1">
            <Icon
              className={cn("size-3.5 shrink-0", color)}
              aria-hidden
            />
            {nameEditor ?? <span className="truncate">{entry.name}</span>}
          </div>
          <div role="gridcell" className="text-muted-foreground truncate px-1 text-right tabular-nums">
            {entry.kind === "file" && formatSize(entry.size)}
            {size?.state === "complete" && formatSize(size.bytes)}
            {size?.state === "calculating" && (
              <span className="inline-flex items-center gap-1">
                <span role="status" className="sr-only">{t("files.folderSize.calculating", { name: entry.name })}</span>
                <LoaderCircle className="size-3 motion-safe:animate-spin" aria-hidden />
                <IconButton
                  label={cancelSize}
                  className="size-5 [&_svg]:size-3"
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    folderSize?.cancel();
                  }}
                >
                  <X />
                </IconButton>
              </span>
            )}
            {sizeError && (
              <span className="text-destructive inline-flex" title={sizeError}>
                <span role="alert" className="sr-only">{sizeError}</span>
                <CircleAlert className="size-3.5" aria-hidden />
              </span>
            )}
          </div>
          {modified !== undefined && (
            <div role="gridcell" title={modified} className="text-muted-foreground truncate px-1 tabular-nums">
              {modified}
            </div>
          )}
          {showPermissions && (
            <div role="gridcell" className="text-muted-foreground truncate px-1 font-mono text-xs">
              {formatPermissions(entry)}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-40"
        onCloseAutoFocus={(event) => {
          if (!renameOnMenuClose.current) return;
          renameOnMenuClose.current = false;
          event.preventDefault();
          onOperation("rename");
        }}
      >
        {dir && <ContextMenuItem onSelect={onOpen}>{t("files.open")}</ContextMenuItem>}
        {folderSize && (size?.state === "calculating" ? (
          <ContextMenuItem onSelect={folderSize.cancel}><X />{cancelSize}</ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={folderSize.calculate}>
            <Calculator />{t("files.folderSize.calculate")}
          </ContextMenuItem>
        ))}
        {isFileLike(entry) && (
          <ContextMenuItem onSelect={onOpen}>
            <FilePen />
            {t(exchange?.side === "local" ? "files.open" : "files.openInEditor")}
          </ContextMenuItem>
        )}
        {onCopy && (
          <ContextMenuItem onSelect={onCopy}>
            {exchange?.side === "local" ? <Upload /> : <Download />}
            {t(exchange?.side === "local" ? "sftp.uploadSelection" : "sftp.downloadSelection")}
          </ContextMenuItem>
        )}
        {onDownload && (
          <ContextMenuItem onSelect={onDownload}>
            <Download />
            {t("files.download")}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => void writeClipboardText(childPath(path, entry.name))}>
          <Copy />
          {t("files.copyPath")}
        </ContextMenuItem>
        {onCut && (
          <ContextMenuItem onSelect={onCut}>
            <Scissors />
            {t("files.move.cut")}
            <ContextMenuShortcut>{shortcutLabel("fileCut", currentPlatform())}</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        {onPaste && <PasteItem onPaste={onPaste} />}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => { renameOnMenuClose.current = true; }}>
          <Pencil />
          {t("files.renameAction")}
        </ContextMenuItem>
        {entry.kind !== "symlink" && !(exchange?.side === "local" && entry.permissions === null) && (
          <ContextMenuItem onSelect={() => onOperation("permissions")}>
            <KeyRound />
            {t("files.permissionsAction")}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => onOperation("newFile")}>
          <FilePlus />
          {t("files.newFileAction")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onOperation("newFolder")}>
          <FolderPlus />
          {t("files.newFolderAction")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onOperation("delete")}>
          <Trash2 />
          {t("files.deleteAction")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function PasteItem({ onPaste }: { onPaste(): void }) {
  const { t } = useTranslation();
  return (
    <ContextMenuItem onSelect={onPaste}>
      <ClipboardPaste />
      {t("files.move.paste")}
      <ContextMenuShortcut>{shortcutLabel("filePaste", currentPlatform())}</ContextMenuShortcut>
    </ContextMenuItem>
  );
}
