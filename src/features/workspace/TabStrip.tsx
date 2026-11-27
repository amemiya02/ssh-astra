import { Columns2, House, Lock, Plus, Rows2, Settings, SquareTerminal, Waypoints, X } from "lucide-react";
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
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { hueClasses } from "@/features/hosts/hostHue";
import type { TerminalTitleSource } from "@/features/terminal/terminal-prefs";
import { cn } from "@/lib/utils";
import { TabMenu } from "./TabMenu";
import { shortcutLabel, type Platform } from "./shortcuts";
import {
  activePane,
  canSplit,
  tabHue,
  tabId,
  tabPanelId,
  tabStatus,
  tabTitle,
  type ConnectionStatus,
  type PaneKind,
  type SplitOrientation,
  type Tab,
  type TabCustomizationAction,
} from "./tabs";

interface TabStripProps {
  tabs: Tab[];
  activeId: string | null;
  platform: Platform;
  titleSource: TerminalTitleSource;
  onActivate(id: string): void;
  onClose(id: string): void;
  onCustomize(action: TabCustomizationAction): void;
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

const kindIcons = {
  home: House,
  "local-terminal": SquareTerminal,
  "remote-terminal": SquareTerminal,
  sftp: SquareTerminal,
  settings: Settings,
  "port-forwards": Waypoints,
} satisfies Record<PaneKind["kind"], unknown>;

/**
 * Compact pill tabs on the window ground; the active one is raised (surface fill, 1px border).
 * Arrow keys move between tabs, Delete and middle-click close, dragging reorders. A Host's tab
 * shows its Connection state as a dot, named in the tooltip, and underlines itself in the Host's hue.
 */
export function TabStrip({
  tabs,
  activeId,
  platform,
  titleSource,
  onActivate,
  onClose,
  onCustomize,
  onMove,
  onNewLocalTerminal,
  onSplit,
}: TabStripProps) {
  const { t } = useTranslation();
  const selected = tabs.find((tab) => tab.id === activeId);
  const listRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
    if (event.key === "Delete" && selected) {
      event.preventDefault();
      if (!selected.locked) onClose(selected.id);
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
    <div className="flex h-full min-w-0 flex-1 items-center gap-1">
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
          className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
          onKeyDown={onKeyDown}
        >
          {tabs.map((tab, index) => {
            const active = tab.id === activeId;
            const pane = activePane(tab);
            const kind = pane.kind;
            const ordinal = tabs.slice(0, index + 1).filter((other) => activePane(other).kind === kind).length;
            const title = tabTitle(tab, t, ordinal, titleSource);
            const status = tabStatus(tab);
            const details = [status && t(`tabs.status.${status}`), tab.locked && t("tabs.locked")].filter(Boolean).join(", ");
            const label = details ? `${title} (${details})` : title;
            const TabIcon = tab.layout.type === "split"
              ? tab.layout.orientation === "horizontal" ? Columns2 : Rows2
              : kindIcons[kind];
            const hue = tabHue(tab);
            return (
              <DraggableTab
                key={tab.id}
                id={tab.id}
                className={cn(
                  "group/tab relative flex h-7 max-w-52 min-w-28 shrink-0 items-center rounded-lg border transition-colors data-dragging:opacity-50",
                  active
                    ? "bg-surface text-foreground border-border"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground active:bg-accent border-transparent",
                )}
                onAuxClick={() => !tab.locked && onClose(tab.id)}
                menu={<TabMenu tab={tab} title={title} onCustomize={onCustomize} />}
              >
                {drop?.id === tab.id && dragging !== tab.id && (
                  <span
                    aria-hidden
                    className={cn(
                      "bg-ring absolute inset-y-1 w-0.5 rounded-full",
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
                  aria-keyshortcuts={tab.locked ? undefined : "Delete"}
                  aria-label={label}
                  tabIndex={active ? 0 : -1}
                  title={label}
                  className="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pr-1 pl-2.5 outline-none focus-visible:ring-[3px]"
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
                {hue && (
                  <span
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute inset-x-2.5 -bottom-px h-0.5 rounded-full",
                      !tab.color && hueClasses[hue].line,
                      !tab.color && !active && "opacity-40",
                    )}
                    style={tab.color ? { backgroundColor: `var(--ansi-${tab.color}-ink)` } : undefined}
                  />
                )}
                {tab.locked ? (
                  <span aria-hidden className="text-muted-foreground mr-1 grid size-5 shrink-0 place-items-center">
                    <Lock className="size-3.5" />
                  </span>
                ) : (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t("tabs.close", { title })}
                    className={cn(
                      "text-muted-foreground hover:bg-accent hover:text-foreground active:bg-accent/70 focus-visible:ring-ring/50 mr-1 grid size-5 shrink-0 place-items-center rounded-md outline-none focus-visible:opacity-100 focus-visible:ring-2",
                      !active && "opacity-0 group-hover/tab:opacity-100",
                    )}
                    onClick={() => onClose(tab.id)}
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                )}
              </DraggableTab>
            );
          })}
        </div>
      </DndContext>
      <IconButton
        label={t("tabs.newLocalTerminal")}
        shortcut={shortcutLabel("newTab", platform)}
        onClick={onNewLocalTerminal}
      >
        <Plus />
      </IconButton>
      <div data-tauri-drag-region className="h-full min-w-4 flex-1" />
      {selected && canSplit(selected) && (
        <>
          <IconButton
            label={t("tabs.splitRight")}
            shortcut={shortcutLabel("splitRight", platform)}
            onClick={() => onSplit("horizontal")}
          >
            <Columns2 />
          </IconButton>
          <IconButton
            label={t("tabs.splitDown")}
            shortcut={shortcutLabel("splitDown", platform)}
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
  menu,
  children,
}: {
  id: string;
  className: string;
  /** Middle-click. */
  onAuxClick(): void;
  menu: ReactNode;
  children: ReactNode;
}) {
  const drag = useDraggable({ id });
  const drop = useDroppable({ id });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
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
      </ContextMenuTrigger>
      {menu}
    </ContextMenu>
  );
}
