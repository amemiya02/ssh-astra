import { Columns2, Plus, Rows2, Settings, SquareTerminal, X } from "lucide-react";
import {
  DndContext,
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
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { cn } from "@/lib/utils";
import { shortcutLabel, type Platform } from "./shortcuts";
import { activePane, tabId, tabPanelId, tabStatus, tabTitle, type ConnectionStatus, type SplitOrientation, type Tab } from "./tabs";

interface TabStripProps {
  tabs: Tab[];
  activeId: string | null;
  platform: Platform;
  onActivate(id: string): void;
  onClose(id: string): void;
  /** Drop the dragged tab `id` at index `to`. */
  onMove(id: string, to: number): void;
  onNewLocalTerminal(): void;
  onSplit(orientation: SplitOrientation): void;
}

const statusDot: Record<ConnectionStatus, string> = {
  connecting: "bg-warning",
  connected: "bg-success",
  disconnected: "bg-destructive",
};

/** Where a dragged tab would land: before or after the tab under the pointer. */
interface DropTarget {
  id: string;
  side: "before" | "after";
}

/**
 * Tabs sit on the chrome; the active one is cut from the Terminal surface below it
 * (same colour, joined edge). Arrow keys move between tabs, Delete and middle-click close,
 * dragging reorders. A Host's tab shows its Connection state as a dot, named in the tooltip.
 */
export function TabStrip({
  tabs,
  activeId,
  platform,
  onActivate,
  onClose,
  onMove,
  onNewLocalTerminal,
  onSplit,
}: TabStripProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Delete" && activeId) {
      event.preventDefault();
      onClose(activeId);
      return;
    }
    const index = tabs.findIndex((tab) => tab.id === activeId);
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    let next: Tab | undefined;
    if (step !== undefined) next = tabs[(index + step + tabs.length) % tabs.length];
    if (event.key === "Home") next = tabs[0];
    if (event.key === "End") next = tabs.at(-1);
    if (!next) return;
    event.preventDefault();
    onActivate(next.id);
    listRef.current?.querySelector<HTMLElement>(`#${tabId(next.id)}`)?.focus();
  };

  // @dnd-kit (pointer events), not HTML5 drag and drop: Tauri's native file drop eats the latter on Windows.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  /** Which side of the tab under the pointer the dragged tab would land on. */
  const dropAt = (event: DragMoveEvent): DropTarget | null => {
    const over = event.over;
    if (!over || over.id === event.active.id) return null;
    const start = event.activatorEvent as PointerEvent;
    const x = (start.clientX ?? 0) + event.delta.x;
    return { id: String(over.id), side: x < over.rect.left + over.rect.width / 2 ? "before" : "after" };
  };

  const showDrop = (event: DragMoveEvent) => {
    const next = dropAt(event);
    setDrop((current) => (current?.id === next?.id && current?.side === next?.side ? current : next));
  };

  const endDrag = (event: DragEndEvent | null) => {
    const target = event && dropAt(event);
    const id = dragging;
    setDragging(null);
    setDrop(null);
    if (!id || !target) return;
    const from = tabs.findIndex((tab) => tab.id === id);
    let to = tabs.findIndex((tab) => tab.id === target.id) + (target.side === "after" ? 1 : 0);
    if (from < to) to -= 1;
    if (to !== from) onMove(id, to);
  };

  return (
    <div className="flex min-w-0 items-end gap-0.5">
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={(event: DragStartEvent) => setDragging(String(event.active.id))}
        onDragMove={showDrop}
        onDragOver={showDrop}
        onDragEnd={endDrag}
        onDragCancel={() => endDrag(null)}
      >
        <div
          ref={listRef}
          role="tablist"
          aria-label={t("tabs.listLabel")}
          className="flex min-w-0 items-end gap-0.5 overflow-x-auto [scrollbar-width:none]"
          onKeyDown={onKeyDown}
        >
          {tabs.map((tab, index) => {
            const active = tab.id === activeId;
            const kind = activePane(tab).kind;
            const ordinal = tabs.slice(0, index + 1).filter((other) => activePane(other).kind === kind).length;
            const title = tabTitle(tab, t, ordinal);
            const status = tabStatus(tab);
            const label = status ? `${title} (${t(`tabs.status.${status}`)})` : title;
            const TabIcon =
              tab.panes.length > 1
                ? tab.orientation === "horizontal"
                  ? Columns2
                  : Rows2
                : kind === "settings"
                  ? Settings
                  : SquareTerminal;
            return (
              <DraggableTab
                key={tab.id}
                id={tab.id}
                className={cn(
                  "group/tab relative flex h-8 max-w-52 min-w-28 shrink-0 items-center rounded-t-lg transition-colors data-dragging:opacity-50",
                  active
                    ? "bg-terminal-background text-foreground z-10 -mb-px h-[calc(2rem+1px)] border border-b-0"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
                onAuxClick={() => onClose(tab.id)}
              >
                {drop?.id === tab.id && dragging !== tab.id && (
                  <span
                    aria-hidden
                    className={cn(
                      "bg-ring absolute inset-y-1.5 w-0.5 rounded-full",
                      drop.side === "before" ? "-left-0.5" : "-right-0.5",
                    )}
                  />
                )}
                <button
                  id={tabId(tab.id)}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={tabPanelId(tab.id)}
                  aria-keyshortcuts="Delete"
                  aria-label={label}
                  tabIndex={active ? 0 : -1}
                  title={label}
                  className="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center gap-2 rounded-t-lg pr-1 pl-3 outline-none focus-visible:ring-[3px]"
                  onClick={() => onActivate(tab.id)}
                >
                  {status ? (
                    <span className="grid size-3.5 shrink-0 place-items-center" aria-hidden>
                      <span
                        data-status={status}
                        className={cn("size-2 rounded-full", statusDot[status], status === "connecting" && "animate-pulse")}
                      />
                    </span>
                  ) : (
                    <TabIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
                  )}
                  <span className="truncate">{title}</span>
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={t("tabs.close", { title })}
                  className={cn(
                    "text-muted-foreground hover:bg-accent hover:text-foreground mr-1.5 grid size-5 shrink-0 place-items-center rounded-md",
                    !active && "opacity-0 group-hover/tab:opacity-100",
                  )}
                  onClick={() => onClose(tab.id)}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </DraggableTab>
            );
          })}
        </div>
      </DndContext>
      <IconButton
        label={t("tabs.newLocalTerminal")}
        shortcut={shortcutLabel("newTab", platform)}
        className="mb-1.5"
        onClick={onNewLocalTerminal}
      >
        <Plus />
      </IconButton>
      {tabs.length > 0 && (
        <>
          <IconButton
            label={t("tabs.splitRight")}
            shortcut={shortcutLabel("splitRight", platform)}
            className="mb-1.5"
            onClick={() => onSplit("horizontal")}
          >
            <Columns2 />
          </IconButton>
          <IconButton
            label={t("tabs.splitDown")}
            shortcut={shortcutLabel("splitDown", platform)}
            className="mb-1.5"
            onClick={() => onSplit("vertical")}
          >
            <Rows2 />
          </IconButton>
        </>
      )}
    </div>
  );
}

/** One tab: draggable by its body (after a 4px move, so clicks still activate) and a drop target. */
function DraggableTab({
  id,
  className,
  onAuxClick,
  children,
}: {
  id: string;
  className: string;
  /** Middle-click. */
  onAuxClick(): void;
  children: ReactNode;
}) {
  const drag = useDraggable({ id });
  const drop = useDroppable({ id });
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      {...drag.listeners}
      data-dragging={drag.isDragging || undefined}
      className={className}
      onAuxClick={(event) => {
        if (event.button === 1) onAuxClick();
      }}
    >
      {children}
    </div>
  );
}
