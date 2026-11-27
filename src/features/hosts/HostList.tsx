import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { ChevronRight, Folder, FolderInput, FolderPlus, Pencil, Terminal, Trash2, Upload, X } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/ui/input";
import type { Group, GroupId, Host, HostId, HostTree } from "@/lib/ipc/hosts";
import { defineSection, useSetting } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { dropMove, type DragItem, type DropPosition, type DropTarget, type MoveOp, type TreeNode } from "./hostTree";
import { ConnectionDot } from "@/features/connect/ConnectionDot";
import type { HostConnection } from "@/features/connect/hostConnection";
import { privacyModeSetting } from "@/features/workspace/privacy-mode";
import { HostMonogram } from "./HostMonogram";
import { OpenSshMissing } from "./openSshSync";
import { emptyHostSelection, selectHost, type HostSelection } from "./host-selection";
import { hostMenuEntries } from "./hostMenu";
import { RowContextMenu, RowMoreMenu, type MenuEntry } from "./RowMenu";

/** What the user can do to rows; `useHostsController` owns the dialogs and the store calls. */
export interface HostListActions {
  open(host: Host): void;
  openSftp(host: Host): void;
  openForwards(host: Host): void;
  /** "Connect only": a Connection with no Terminal (and its auto-start Port forwards). */
  connectOnly(host: Host): void;
  /** Ends "Connect only" on a held Host. */
  disconnect(host: Host): void;
  /** Whether the Host is held by "Connect only" (or connecting). */
  isHeld(host: Host): boolean;
  edit(host: Host): void;
  duplicate(host: Host): void;
  remove(item: { kind: "host"; host: Host } | { kind: "group"; group: Group }): void;
  createGroup(parentId: GroupId | null): void;
  startRename(id: GroupId): void;
  rename(id: GroupId, name: string): void;
  cancelRename(): void;
  move(op: MoveOp): void;
}

export interface HostBatchActions {
  move(ids: readonly HostId[], groupId: GroupId | null): void;
  editTag(ids: readonly HostId[], change: "addTag" | "removeTag"): void;
  remove(ids: readonly HostId[]): void;
  connect(ids: readonly HostId[]): void;
  export(ids: readonly HostId[]): void;
}

interface HostListProps {
  tree: HostTree;
  /** The nodes to show: the whole tree, or search results. */
  nodes: TreeNode[];
  /** While searching every Group is open and dragging is off. */
  searching: boolean;
  /** Only the saved manual order supports drag and drop. */
  manualOrder: boolean;
  selectedGroupId: GroupId | null;
  onSelectGroup(id: GroupId): void;
  selection: HostSelection;
  onSelectHosts(selection: HostSelection): void;
  renamingGroupId: GroupId | null;
  /** Each Host's Connection, for the dot on its row. */
  connections: ReadonlyMap<HostId, HostConnection>;
  actions: HostListActions;
  batchActions: HostBatchActions;
}

/** Host list preferences in the settings file. */
interface HostListPrefs {
  /** Groups the user closed, remembered across restarts. */
  collapsedGroups: GroupId[];
}

const hostListSetting = defineSection<HostListPrefs>("hostList", { collapsedGroups: [] }, (raw) => {
  const saved = typeof raw === "object" && raw !== null ? (raw as { collapsedGroups?: unknown }).collapsedGroups : [];
  return {
    collapsedGroups: Array.isArray(saved) ? saved.filter((id): id is GroupId => typeof id === "string") : [],
  };
});

/** Which Groups are closed, remembered across restarts. */
function useCollapsedGroups() {
  const [prefs, setPrefs] = useSetting(hostListSetting);
  const collapsed = useMemo(() => new Set(prefs.collapsedGroups), [prefs]);
  const toggle = (id: GroupId, open?: boolean) => {
    const next = new Set(collapsed);
    if (open ?? next.has(id)) next.delete(id);
    else next.add(id);
    if (next.size !== collapsed.size) setPrefs({ ...prefs, collapsedGroups: [...next] });
  };
  return { collapsed, toggle };
}

type DragData = { item: DragItem; label: string };
type DropState = { key: string; position: DropPosition; op: MoveOp };

const keyOf = (item: DragItem | DropTarget) => (item.kind === "root" ? "root" : `${item.kind}:${item.id}`);

function selectionMode(event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) {
  if (event.shiftKey) return "range";
  if (event.metaKey || event.ctrlKey) return "toggle";
  return "single";
}

/**
 * The Host list tree: nested Groups (collapsible), Hosts with search
 * highlights, right-click and "More actions" menus, and drag and drop to move
 * and reorder. Dropping on the top or bottom edge of a row places the item
 * before or after it; dropping on the middle of a Group puts it inside.
 */
export function HostList({
  tree,
  nodes,
  searching,
  manualOrder,
  selectedGroupId,
  onSelectGroup,
  selection,
  onSelectHosts,
  renamingGroupId,
  connections,
  actions,
  batchActions,
}: HostListProps) {
  const { t } = useTranslation();
  const [privacyMode] = useSetting(privacyModeSetting);
  const { collapsed, toggle } = useCollapsedGroups();
  const [dragging, setDragging] = useState<DragData | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const canDrag = manualOrder && !searching;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const visibleIds = useMemo(() => {
    const ids: HostId[] = [];
    const visit = (list: TreeNode[]) => {
      for (const node of list) {
        if (node.kind === "host") ids.push(node.host.id);
        else if (searching || !collapsed.has(node.group.id)) visit(node.children);
      }
    };
    visit(nodes);
    return ids;
  }, [nodes, collapsed, searching]);
  const selectedInList = new Set(selection.ids);
  const ids = visibleIds.filter((id) => selectedInList.has(id));
  const selectedSet = new Set(ids);
  const clearSelection = () => {
    listRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
    onSelectHosts(emptyHostSelection);
  };

  /** Where the pointer is over the row it hovers, as a drop (null: not allowed here). */
  const dropAt = (event: DragMoveEvent): DropState | null => {
    if (!canDrag) return null;
    const data = event.active.data.current as DragData | undefined;
    const over = event.over;
    if (!data || !over) return null;
    const target = (over.data.current as { target: DropTarget }).target;
    const start = event.activatorEvent as PointerEvent;
    const y = (start.clientY ?? 0) + event.delta.y;
    const ratio = over.rect.height > 0 ? (y - over.rect.top) / over.rect.height : 0.5;
    let position: DropPosition = "inside";
    if (target.kind === "host") position = ratio < 0.5 ? "before" : "after";
    else if (target.kind === "group") position = ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside";
    const op = dropMove(tree, data.item, target, position);
    return op ? { key: String(over.id), position, op } : null;
  };

  const showDrop = (event: DragMoveEvent) => {
    const next = dropAt(event);
    setDrop((current) => (current?.key === next?.key && current?.position === next?.position ? current : next));
  };

  const endDrag = (event: DragEndEvent | null) => {
    const op = event && dropAt(event)?.op;
    setDragging(null);
    setDrop(null);
    if (op) {
      // Open the Group it went into so the user sees where it landed.
      if (op.parentId) toggle(op.parentId, true);
      actions.move(op);
    }
  };

  const groupEntries = (
    action: (groupId: GroupId | null) => { disabled?: boolean; onSelect(): void },
  ): MenuEntry[] => {
    const entries: MenuEntry[] = [];
    entries.push({ type: "item", label: t("hosts.topLevel"), ...action(null) });
    const walk = (parent: GroupId | null, depth: number) => {
      for (const g of tree.groups.filter((g) => g.parentId === parent)) {
        entries.push({ type: "item", label: g.name, depth, ...action(g.id) });
        walk(g.id, depth + 1);
      }
    };
    walk(null, 1);
    return entries;
  };
  const moveEntries = (item: DragItem) => groupEntries((id) => {
    const target: DropTarget = id === null ? { kind: "root" } : { kind: "group", id };
    const op = dropMove(tree, item, target, "inside");
    return { disabled: !op, onSelect: () => op && actions.move(op) };
  });

  const render = (list: TreeNode[]): ReactNode =>
    list.map((node) => {
      if (node.kind === "host") {
        const item: DragItem = { kind: "host", id: node.host.id };
        const key = keyOf(item);
        const host = node.host;
        const entries = hostMenuEntries(host, actions, t, moveEntries(item));
        return (
          <li key={key}>
            <TreeRow
              item={item}
              label={host.name}
              disabled={!canDrag}
              dropPosition={canDrag && drop?.key === key ? drop.position : undefined}
              entries={entries}
              moreLabel={t("hosts.moreActions")}
            >
              <HostRowButton
                host={host}
                privacyMode={privacyMode}
                matches={node.matches}
                connection={connections.get(host.id)}
                selected={selectedSet.has(host.id)}
                onSelect={(mode) => onSelectHosts(selectHost(selection, host.id, visibleIds, mode))}
                onClear={() => {
                  if (ids.length) onSelectHosts(emptyHostSelection);
                }}
                onOpen={() => actions.open(host)}
                onEdit={() => actions.edit(host)}
                onDelete={() => {
                  if (ids.length > 1 && selectedSet.has(host.id)) batchActions.remove(ids);
                  else actions.remove({ kind: "host", host });
                }}
              />
            </TreeRow>
          </li>
        );
      }

      const group = node.group;
      const item: DragItem = { kind: "group", id: group.id };
      const key = keyOf(item);
      const open = searching || !collapsed.has(group.id);
      const entries: MenuEntry[] = [
        {
          type: "item",
          label: t("hosts.newGroup"),
          icon: <FolderPlus />,
          onSelect: () => {
            toggle(group.id, true);
            actions.createGroup(group.id);
          },
        },
        { type: "item", label: t("hosts.rename"), icon: <Pencil />, onSelect: () => actions.startRename(group.id) },
        { type: "sub", label: t("hosts.moveTo"), icon: <FolderInput />, entries: moveEntries(item) },
        { type: "separator" },
        {
          type: "item",
          label: t("hosts.delete"),
          icon: <Trash2 />,
          destructive: true,
          onSelect: () => actions.remove({ kind: "group", group }),
        },
      ];
      return (
        <li key={key}>
          <TreeRow
            item={item}
            label={group.name}
            disabled={!canDrag || renamingGroupId === group.id}
            dropPosition={canDrag && drop?.key === key ? drop.position : undefined}
            entries={entries}
            moreLabel={t("hosts.moreActions")}
          >
            {renamingGroupId === group.id ? (
              <GroupNameInput
                name={group.name}
                onCommit={(name) => actions.rename(group.id, name)}
                onCancel={actions.cancelRename}
              />
            ) : (
              <GroupRowButton
                group={group}
                open={open}
                selected={selectedGroupId === group.id}
                onToggle={() => {
                  onSelectGroup(group.id);
                  if (!searching) toggle(group.id);
                }}
                onRename={() => actions.startRename(group.id)}
                onDelete={() => actions.remove({ kind: "group", group })}
              />
            )}
          </TreeRow>
          {open && (
            <ul role="group" aria-label={group.name} className="grid grid-cols-[minmax(0,1fr)] gap-0.5 pt-0.5 pl-3">
              {node.children.length > 0 ? (
                render(node.children)
              ) : (
                <li className="text-muted-foreground px-2 py-1 text-xs">
                  {t(canDrag ? "hosts.emptyGroup" : "hosts.emptyGroupSorted")}
                </li>
              )}
            </ul>
          )}
        </li>
      );
    });

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={(event: DragStartEvent) => setDragging((event.active.data.current as DragData) ?? null)}
      onDragMove={showDrop}
      onDragOver={showDrop}
      onDragEnd={endDrag}
      onDragCancel={() => endDrag(null)}
    >
      <div className="flex min-h-full flex-col">
        <ul ref={listRef} aria-label={t("hosts.title")} className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
          {render(nodes)}
        </ul>
        {canDrag && <RootDropZone active={drop?.key === "root"} />}
        {visibleIds.length > 0 && (
          <div className="bg-sidebar sticky bottom-0 z-10 mt-auto flex h-8 shrink-0 items-center gap-1 border-t px-2">
            <span role="status" className="min-w-0 flex-1 truncate text-xs tabular-nums">
              {ids.length ? t("hosts.batch.selected", { count: ids.length }) : t("hosts.batch.visible", { count: visibleIds.length })}
            </span>
            {ids.length > 0 && (
              <>
                <RowMoreMenu
                  label={t("hosts.batch.actions")}
                  align="end"
                  entries={[
                    { type: "item", label: t("hosts.batch.connect"), icon: <Terminal />, onSelect: () => batchActions.connect(ids) },
                    {
                      type: "sub",
                      label: t("hosts.moveTo"),
                      icon: <FolderInput />,
                      entries: groupEntries((id) => ({ onSelect: () => batchActions.move(ids, id) })),
                    },
                    { type: "item", label: t("hosts.batch.addTag"), onSelect: () => batchActions.editTag(ids, "addTag") },
                    {
                      type: "item",
                      label: t("hosts.batch.removeTag"),
                      disabled: !tree.hosts.some((host) => selectedSet.has(host.id) && host.tags?.length),
                      onSelect: () => batchActions.editTag(ids, "removeTag"),
                    },
                    { type: "item", label: t("hosts.batch.export"), icon: <Upload />, onSelect: () => batchActions.export(ids) },
                    { type: "separator" },
                    { type: "item", label: t("hosts.delete"), icon: <Trash2 />, destructive: true, onSelect: () => batchActions.remove(ids) },
                  ]}
                />
                <IconButton label={t("hosts.batch.clear")} onClick={clearSelection}><X /></IconButton>
              </>
            )}
          </div>
        )}
      </div>
      <DragOverlay dropAnimation={null}>
        {canDrag && dragging && (
          <div className="bg-popover shadow-overlay w-fit max-w-56 truncate rounded-md border px-2.5 py-1 font-medium">
            {dragging.label}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

/** The empty space under the list: dropping here moves to the end of the top level. */
function RootDropZone({ active }: { active: boolean }) {
  const { setNodeRef } = useDroppable({ id: "root", data: { target: { kind: "root" } satisfies DropTarget } });
  return (
    <div ref={setNodeRef} className="relative min-h-8 flex-1">
      {active && <span aria-hidden className="bg-ring absolute inset-x-1 top-0 h-0.5 rounded-full" />}
    </div>
  );
}

/** A draggable, droppable row with a context menu and a hover "More actions" button. */
function TreeRow({
  item,
  label,
  disabled,
  dropPosition,
  entries,
  moreLabel,
  children,
}: {
  item: DragItem;
  label: string;
  disabled: boolean;
  dropPosition?: DropPosition;
  entries: MenuEntry[];
  moreLabel: string;
  children: ReactNode;
}) {
  const key = keyOf(item);
  const drag = useDraggable({ id: key, data: { item, label } satisfies DragData, disabled });
  const drop = useDroppable({ id: key, data: { target: item }, disabled });
  return (
    <RowContextMenu entries={entries}>
      <div
        ref={(el) => {
          drag.setNodeRef(el);
          drop.setNodeRef(el);
        }}
        {...drag.listeners}
        className={cn(
          "group/row relative flex items-center rounded-lg",
          drag.isDragging && "opacity-50",
          dropPosition === "inside" && "bg-selected ring-ring ring-1",
        )}
      >
        {children}
        <RowMoreMenu
          entries={entries}
          label={moreLabel}
          className="absolute right-1 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        />
        {(dropPosition === "before" || dropPosition === "after") && (
          <span
            aria-hidden
            className={cn(
              "bg-ring pointer-events-none absolute inset-x-1 h-0.5 rounded-full",
              dropPosition === "before" ? "-top-px" : "-bottom-px",
            )}
          />
        )}
      </div>
    </RowContextMenu>
  );
}

const rowButton =
  "focus-visible:ring-ring/50 flex w-full min-w-0 items-center rounded-lg text-left outline-none focus-visible:ring-[3px]";

function HostRowButton({
  host,
  privacyMode,
  matches,
  connection,
  selected,
  onSelect,
  onClear,
  onOpen,
  onEdit,
  onDelete,
}: {
  host: Host;
  privacyMode: boolean;
  matches?: Extract<TreeNode, { kind: "host" }>["matches"];
  connection?: HostConnection;
  selected: boolean;
  onSelect(mode: ReturnType<typeof selectionMode>): void;
  onClear(): void;
  onOpen(): void;
  onEdit(): void;
  onDelete(): void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      title={t("hosts.openHint")}
      aria-pressed={selected}
      aria-keyshortcuts="Enter Space Shift+Space Control+Space Meta+Space"
      className={cn(rowButton, "h-7.5 gap-2 px-2 pr-8", selected ? "bg-selected" : "hover:bg-accent active:bg-accent/70")}
      onClick={(event) => onSelect(selectionMode(event))}
      onDoubleClick={(event) => {
        if (selectionMode(event) === "single") onOpen();
      }}
      onKeyDown={(event) => {
        const mode = selectionMode(event);
        if ((event.key === "Enter" || event.key === " ") && mode !== "single") {
          event.preventDefault();
          if (!event.repeat) onSelect(mode);
        } else if (event.key === "Enter") {
          event.preventDefault();
          onOpen();
        } else if (event.key === "Escape") {
          onClear();
        } else if (event.key === "F2") {
          event.preventDefault();
          onEdit();
        } else if (event.key === "Delete" || (event.key === "Backspace" && event.metaKey)) {
          event.preventDefault();
          onDelete();
        }
      }}
    >
      <HostMonogram host={host} />
      <span className={cn("flex items-center gap-1.5", privacyMode ? "min-w-0" : "max-w-[65%] shrink-0")}>
        <span className="truncate font-medium">
          <Highlighted text={host.name} indexes={matches?.name} />
        </span>
        <OpenSshMissing host={host} />
        {connection && (
          <>
            <ConnectionDot state={connection} />
            <span className="sr-only">{t(`tabs.status.${connection}`)}</span>
          </>
        )}
      </span>
      {!privacyMode && (
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
          <Highlighted text={host.user} indexes={matches?.user} />@
          <Highlighted text={host.address} indexes={matches?.address} />
          {host.port === 22 ? "" : `:${host.port}`}
        </span>
      )}
    </button>
  );
}

function GroupRowButton({
  group,
  open,
  selected,
  onToggle,
  onRename,
  onDelete,
}: {
  group: Group;
  open: boolean;
  selected: boolean;
  onToggle(): void;
  onRename(): void;
  onDelete(): void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-current={selected || undefined}
      className={cn(
        rowButton,
        "text-muted-foreground h-7 gap-1.5 px-1.5 pr-8 text-xs font-semibold",
        selected ? "bg-selected" : "hover:bg-accent",
      )}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "F2") {
          event.preventDefault();
          onRename();
        } else if (event.key === "Delete" || (event.key === "Backspace" && event.metaKey)) {
          event.preventDefault();
          onDelete();
        }
      }}
    >
      <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      <Folder aria-hidden className="text-primary size-3.5 shrink-0" />
      <span className="truncate">{group.name}</span>
    </button>
  );
}

/** Inline rename: Enter or leaving the field saves, Escape cancels. */
function GroupNameInput({ name, onCommit, onCancel }: { name: string; onCommit(name: string): void; onCancel(): void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(name);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const trimmed = value.trim();
    if (commit && trimmed && trimmed !== name) onCommit(trimmed);
    else onCancel();
  };
  return (
    <Input
      aria-label={t("hosts.groupName")}
      className="h-7 px-2 text-xs font-semibold"
      value={value}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(true);
        else if (event.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** `text` with the characters at `indexes` emphasised. */
export function Highlighted({ text, indexes }: { text: string; indexes?: number[] }) {
  if (!indexes?.length) return <>{text}</>;
  const hit = new Set(indexes);
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = runs.at(-1);
    const char = text.charAt(i);
    if (last && last.hit === hit.has(i)) last.text += char;
    else runs.push({ text: char, hit: hit.has(i) });
  }
  return (
    <>
      {runs.map((run, i) =>
        run.hit ? (
          <mark key={i} className="text-foreground bg-transparent font-semibold">
            {run.text}
          </mark>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}
