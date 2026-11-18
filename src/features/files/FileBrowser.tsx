import { useDraggable } from "@dnd-kit/core";
import {
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  File,
  FilePen,
  FileSymlink,
  Folder,
  FolderPlus,
  FolderSymlink,
  KeyRound,
  Pencil,
  Trash2,
  Upload,
  Search,
} from "lucide-react";
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Input } from "@/components/ui/input";
import { IconButton } from "@/components/IconButton";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { FileEntry } from "@/lib/ipc/files";
import { writeClipboardText } from "@/lib/ipc/system";
import { useSetting } from "@/lib/storage";
import { cn } from "@/lib/utils";
import type { FileBrowserStore } from "./fileBrowsers";
import type { SelectMode } from "./fileBrowserStore";
import { errorText } from "./fileErrors";
import { FileOperationDialog, type FileOperation } from "./FileOperationDialogs";
import { filesSetting } from "./file-prefs";
import {
  childPath,
  formatPermissions,
  formatSize,
  isDirLike,
  isFileLike,
  shownEntries,
  visibleRows,
  type SortKey,
} from "./fileList";

/** Every row is this tall, so only the rows in view are rendered (directories may hold 10,000+ entries). */
const rowHeight = 26;
const overscan = 8;
/** Name | size | modified | permissions; modified and permissions appear as the panel widens. */
const columns =
  "grid grid-cols-[minmax(0,1fr)_4.5rem] @sm:grid-cols-[minmax(0,1fr)_4.5rem_8.5rem] @md:grid-cols-[minmax(0,1fr)_4.5rem_8.5rem_6rem]";

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
}: {
  store: FileBrowserStore;
  hostName: string;
  onDownload?(names: string[]): void;
  exchange?: FileExchange;
}) {
  const { t } = useTranslation();
  const path = useStore(store, (s) => s.path);
  const error = useStore(store, (s) => s.error);
  const [operation, setOperation] = useState<FileOperation | null>(null);
  return (
    <div className="@container flex h-full flex-col">
      {/* Sibling keys must differ: PathBar and FileTable sharing the path as key made React keep the old path bar. */}
      <PathBar key={`path:${path ?? ""}`} store={store} onOperation={setOperation} />
      {error && path !== null && (
        <p role="alert" className="text-destructive px-3 pb-1.5 text-xs">
          {errorText(t, error, hostName)}
        </p>
      )}
      {/* Keyed by path: a new directory starts scrolled to the top with nothing focused. */}
      {path !== null && (
        <FileTable key={`table:${path}`} store={store} path={path}
          onOperation={setOperation} onDownload={onDownload} exchange={exchange} />
      )}
      {operation && <FileOperationDialog store={store} operation={operation} onClose={() => setOperation(null)} />}
    </div>
  );
}

/** The directory being shown, editable: type a path and press Enter to go there. */
function PathBar({ store, onOperation }: { store: FileBrowserStore; onOperation(operation: FileOperation): void }) {
  const { t } = useTranslation();
  const path = useStore(store, (s) => s.path);
  // Remounted (keyed by path) when the directory changes, which resets the draft.
  const [draft, setDraft] = useState(path ?? "");

  return (
    <form
      className="flex shrink-0 items-center gap-1 p-2"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDraft(path ?? "");
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim()) void store.getState().navigate(draft);
      }}
    >
      <div className="bg-muted flex h-7 min-w-0 flex-1 items-center gap-0.5 rounded-lg pr-2 pl-0.5">
        <IconButton
          type="button"
          label={t("files.up")}
          className="size-6"
          disabled={path === null || path === "/"}
          onClick={() => void store.getState().up()}
        >
          <ArrowUp />
        </IconButton>
        <input
          aria-label={t("files.path")}
          value={draft}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDraft(path ?? "");
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {draft !== (path ?? "") && (
          <IconButton type="submit" label={t("files.goToPath")} className="size-6"
            disabled={!draft.trim()} onPointerDown={(event) => event.preventDefault()}>
            <ArrowRight />
          </IconButton>
        )}
      </div>
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
}: {
  store: FileBrowserStore;
  path: string;
  onOperation(operation: FileOperation): void;
  onDownload?(names: string[]): void;
  exchange?: FileExchange;
}) {
  const { t, i18n } = useTranslation();
  const entries = useStore(store, (s) => s.entries);
  const selection = useStore(store, (s) => s.selection);
  const loading = useStore(store, (s) => s.loading);
  const [prefs, setPrefs] = useSetting(filesSetting);
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    const shown = shownEntries(entries, prefs.sort, prefs.showHidden);
    return query ? shown.filter((entry) => entry.name.toLocaleLowerCase().includes(query)) : shown;
  }, [entries, prefs, filter]);
  const order = useMemo(() => rows.map((r) => r.name), [rows]);
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }),
    [i18n.language],
  );

  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    setViewport(element.clientHeight);
    return () => observer.disconnect();
  }, []);
  const [focused, setFocused] = useState<string | null>(null);
  const focusIndex = focused === null ? -1 : order.indexOf(focused);
  const { start, end } = visibleRows({ scrollTop, viewport, rowHeight, count: rows.length, overscan });
  const baseId = useId();
  const rowId = (index: number) => `${baseId}-row-${index}`;

  const select = (name: string, mode: SelectMode) => {
    setFocused(name);
    store.getState().select(name, mode, order);
  };
  const reveal = (index: number) => {
    const element = scroller.current;
    if (!element) return;
    const top = index * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight)
      element.scrollTop = top + rowHeight - element.clientHeight;
  };
  const sortBy = (key: SortKey) => {
    const direction = prefs.sort.key === key && prefs.sort.direction === "asc" ? "desc" : "asc";
    setPrefs({ ...prefs, sort: { key, direction } });
  };

  /** The selection in display order, for a delete. */
  const selected = useMemo(() => order.filter((name) => selection.has(name)), [order, selection]);
  const askDelete = () => {
    const names = selected;
    if (names.length > 0) onOperation({ kind: "delete", names });
  };

  const onKeyDown = (event: KeyboardEvent) => {
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
          onOperation({ kind: "rename", name: row.name });
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
      <div
        role="grid"
        aria-label={t("files.listLabel", { path })}
        aria-rowcount={rows.length + 1}
        aria-multiselectable
        aria-busy={loading}
        aria-activedescendant={focusIndex >= 0 ? rowId(focusIndex) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="focus-visible:ring-ring/50 flex min-h-0 flex-1 flex-col text-[12.5px] outline-none focus-visible:ring-[3px] focus-visible:ring-inset"
      >
        <div role="row" aria-rowindex={1} className={cn(columns, "shrink-0 px-2 pb-1")}>
          <HeaderCell label={t("files.columns.name")} sortKey="name" sort={prefs.sort} onSort={sortBy} />
          <HeaderCell label={t("files.columns.size")} sortKey="size" sort={prefs.sort} onSort={sortBy} end />
          <HeaderCell
            label={t("files.columns.modified")}
            sortKey="modified"
            sort={prefs.sort}
            onSort={sortBy}
            className="hidden @sm:flex"
          />
          <HeaderCell
            label={t("files.columns.permissions")}
            sortKey="permissions"
            sort={prefs.sort}
            onSort={sortBy}
            className="hidden @md:flex"
          />
        </div>
        <div
          ref={scroller}
          className={cn("min-h-0 flex-1 overflow-auto px-2 pb-2", loading && "opacity-70")}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          {rows.length === 0 ? (
            <p className="text-muted-foreground p-6 text-center">{filter.trim() ? t("sftp.noMatches") : t("files.emptyFolder")}</p>
          ) : (
            <div role="rowgroup" className="relative" style={{ height: rows.length * rowHeight }}>
              {rows.slice(start, end).map((entry, offset) => {
                const index = start + offset;
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
                    onCopy={paths && (() => exchange?.copy?.(paths))}
                    selected={selection.has(entry.name)}
                    focused={index === focusIndex}
                    modified={entry.modified === null ? "" : dateFormat.format(entry.modified * 1000)}
                    onClick={(event) => select(entry.name, clickMode(event))}
                    onOpen={() => void store.getState().open(entry)}
                    onContextMenu={() => {
                      if (!selection.has(entry.name)) select(entry.name, "only");
                    }}
                    onOperation={(kind) => {
                      if (kind === "rename") onOperation({ kind, name: entry.name });
                      else if (kind === "permissions") onOperation({ kind, entry });
                      else if (kind === "newFolder") onOperation({ kind });
                      else onOperation({ kind, names });
                    }}
                    onDownload={onDownload && (() => onDownload(names))}
                  />
                );
              })}
            </div>
          )}
        </div>
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
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; direction: "asc" | "desc" };
  onSort(key: SortKey): void;
  end?: boolean;
  className?: string;
}) {
  const active = sort.key === sortKey;
  const Arrow = sort.direction === "asc" ? ChevronUp : ChevronDown;
  return (
    <div
      role="columnheader"
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      className={cn("flex min-w-0", end && "justify-end", className)}
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
  modified,
  onClick,
  onOpen,
  onContextMenu,
  onOperation,
  onDownload,
  exchange,
  dragPaths,
  onCopy,
}: {
  id: string;
  index: number;
  entry: FileEntry;
  path: string;
  selected: boolean;
  focused: boolean;
  modified: string;
  onClick(event: MouseEvent): void;
  onOpen(): void;
  onContextMenu(): void;
  onOperation(kind: FileOperation["kind"]): void;
  onDownload?: () => void;
  exchange?: FileExchange;
  dragPaths?: string[];
  onCopy?: () => void;
}) {
  const { t } = useTranslation();
  const { setNodeRef, listeners, isDragging } = useDraggable({ id, disabled: !dragPaths, data: { side: exchange?.side, paths: dragPaths } });
  const dir = isDirLike(entry);
  const Icon = entry.kind === "symlink" ? (dir ? FolderSymlink : FileSymlink) : dir ? Folder : File;
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
            columns,
            "absolute inset-x-0 items-center rounded-sm px-1 select-none",
            selected ? "bg-selected" : "hover:bg-accent/60",
            isDragging && "opacity-50",
            focused && "ring-ring/40 ring-1 ring-inset",
          )}
          style={{ top: index * rowHeight, height: rowHeight }}
          onClick={onClick}
          onDoubleClick={onOpen}
          onContextMenu={onContextMenu}
        >
          <div role="gridcell" className="flex min-w-0 items-center gap-1.5 px-1">
            <Icon
              className={cn("size-3.5 shrink-0", dir ? "text-primary" : "text-muted-foreground")}
              aria-hidden
            />
            <span className="truncate">{entry.name}</span>
          </div>
          <div role="gridcell" className="text-muted-foreground truncate px-1 text-right tabular-nums">
            {entry.kind === "file" ? formatSize(entry.size) : ""}
          </div>
          <div role="gridcell" className="text-muted-foreground hidden truncate px-1 tabular-nums @sm:block">
            {modified}
          </div>
          <div role="gridcell" className="text-muted-foreground hidden truncate px-1 font-mono text-xs @md:block">
            {formatPermissions(entry)}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        {dir && <ContextMenuItem onSelect={onOpen}>{t("files.open")}</ContextMenuItem>}
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
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onOperation("rename")}>
          <Pencil />
          {t("files.renameAction")}
        </ContextMenuItem>
        {!(exchange?.side === "local" && entry.permissions === null) && (
          <ContextMenuItem onSelect={() => onOperation("permissions")}>
            <KeyRound />
            {t("files.permissionsAction")}
          </ContextMenuItem>
        )}
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
