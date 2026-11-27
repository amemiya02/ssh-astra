import { ArrowDownUp, Cable, ChevronRight, CircleDot, Columns2, FileText, House, Lock, PanelLeftClose, PanelLeftOpen, Plus, Rows2, Settings, SquareTerminal, Waypoints, X } from "lucide-react";
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
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { IconButton } from "@/components/IconButton";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { agentAccessSetting } from "@/features/agent/agent-access";
import { HostMonogram } from "@/features/hosts/HostMonogram";
import { hueClasses } from "@/features/hosts/hostHue";
import { LocalShellMenu } from "@/features/terminal/LocalShellMenu";
import { terminalOutputs } from "@/features/terminal/terminal-outputs";
import type { TerminalTitleSource } from "@/features/terminal/terminal-prefs";
import type { Host, TemporaryHost } from "@/lib/ipc/hosts";
import { getSetting, setSetting, useSetting } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { TabMenu } from "./TabMenu";
import { useResolvedShortcuts } from "./shortcut-settings";
import { shortcutLabel, type Platform } from "./shortcuts";
import type { TabActivity } from "./tab-activity";
import { privacyModeSetting, workspaceHostName } from "./privacy-mode";
import { groupTabsByHost, type TabGroup } from "./tab-groups";
import { workspaceSetting } from "./workspace-prefs";
import {
  activePane,
  canSplit,
  tabHue,
  tabId,
  tabPanelId,
  tabPanes,
  tabStatus,
  tabTitle,
  type ConnectionStatus,
  type PaneKind,
  type SplitOrientation,
  type Tab,
  type TabMenuAction,
} from "./tabs";

interface TabStripProps {
  activity: TabActivity;
  tabs: Tab[];
  hosts: readonly Host[];
  activeId: string | null;
  platform: Platform;
  titleSource: TerminalTitleSource;
  onActivate(id: string): void;
  onTabAction(action: TabMenuAction): void;
  /** Drop the dragged tab `id` at index `to`. */
  onMove(id: string, to: number): void;
  onNewLocalTerminal(): void;
  onNewLocalShell(id: string): void;
  onSplit(orientation: SplitOrientation): void;
  onSaveTemporaryHost?(host: TemporaryHost): void;
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
  transfers: ArrowDownUp,
  "port-forwards": Waypoints,
} satisfies Record<PaneKind["kind"], unknown>;

/**
 * Compact pill tabs on the window ground; the active one is raised (surface fill, 1px border).
 * Arrow keys move between tabs, Delete and middle-click close, dragging reorders. A Host's tab
 * shows its Host tile, a Connection dot named in the tooltip, and an underline in the Host's hue.
 */
export function TabStrip({
  activity,
  tabs,
  hosts,
  activeId,
  platform,
  titleSource,
  onActivate,
  onTabAction,
  onMove,
  onNewLocalTerminal,
  onNewLocalShell,
  onSplit,
  onSaveTemporaryHost,
}: TabStripProps) {
  const { t } = useTranslation();
  const shortcuts = useResolvedShortcuts(platform);
  const { unread, flashing } = useStore(activity.store);
  const savedById = useMemo(() => new Map(hosts.map((host) => [host.id, host])), [hosts]);
  const outputs = useStore(terminalOutputs.store);
  const [{ enabled: agentEnabled }] = useSetting(agentAccessSetting);
  const [privacyMode] = useSetting(privacyModeSetting);
  const [{ tabOrientation, verticalTabsCompact, groupTabsByHost: grouping }] = useSetting(workspaceSetting);
  const vertical = tabOrientation === "vertical";
  const compact = vertical && verticalTabsCompact;
  const groups = useMemo((): TabGroup[] => vertical && grouping
    ? groupTabsByHost(tabs)
    : tabs.map((tab) => ({ type: "tab", tab })), [grouping, tabs, vertical]);
  const ordered = groups.flatMap((group) => group.type === "host" ? group.tabs : [group.tab]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const visible = groups.flatMap((group) => group.type === "host"
    ? collapsed.has(group.host.id) ? [] : group.tabs
    : [group.tab]);
  const focusableTabId = visible.find((tab) => tab.id === activeId)?.id ?? visible[0]?.id;

  function toggleHost(hostId: string) {
    setCollapsed((closed) => {
      const next = new Set(closed);
      if (next.has(hostId)) next.delete(hostId);
      else next.add(hostId);
      return next;
    });
  }

  function toggleCompact() {
    const prefs = getSetting(workspaceSetting);
    setSetting(workspaceSetting, { ...prefs, verticalTabsCompact: !prefs.verticalTabsCompact });
  }
  const selected = tabs.find((tab) => tab.id === activeId);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !event.currentTarget.contains(target) || target.getAttribute("role") !== "tab") return;
    const index = visible.findIndex((tab) => tabId(tab.id) === target.id);
    if (event.key === "Delete") {
      event.preventDefault();
      const tab = visible[index];
      if (tab && !tab.locked) onTabAction({ type: "close", id: tab.id });
      return;
    }
    const step = vertical ? { ArrowDown: 1, ArrowUp: -1 }[event.key] : { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    let next: Tab | undefined;
    if (step !== undefined) next = visible[(index + step + visible.length) % visible.length];
    if (event.key === "Home") next = visible[0];
    if (event.key === "End") next = visible.at(-1);
    if (!next) return;
    event.preventDefault();
    onActivate(next.id);
    document.getElementById(tabId(next.id))?.focus();
  };

  // @dnd-kit (pointer events), not HTML5 drag and drop: Tauri's native file drop eats the latter on Windows.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  /** Which side of the tab under the pointer the dragged tab would land on. */
  const dropAt = (event: DragMoveEvent): DropTarget | null => {
    const over = event.over;
    if (!over || over.id === event.active.id) return null;
    const start = event.activatorEvent as PointerEvent;
    const before = vertical
      ? start.clientY + event.delta.y < over.rect.top + over.rect.height / 2
      : start.clientX + event.delta.x < over.rect.left + over.rect.width / 2;
    return { id: String(over.id), side: before ? "before" : "after" };
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

  const ordinals = new Map<string, number>();
  const kinds = new Map<PaneKind["kind"], number>();
  for (const tab of tabs) {
    const kind = activePane(tab).kind;
    const ordinal = (kinds.get(kind) ?? 0) + 1;
    kinds.set(kind, ordinal);
    ordinals.set(tab.id, ordinal);
  }

  function sharesTerminal(tab: Tab) {
    return agentEnabled && tabPanes(tab).some((pane) => {
      if (pane.kind !== "remote-terminal" || !pane.savedHostTerminal) return false;
      const permission = savedById.get(pane.host.id)?.agentAccess;
      return permission === "read" || permission === "approval";
    });
  }

  function renderTab(tab: Tab, grouped = false, hidden = false) {
    const active = tab.id === activeId;
    const pane = activePane(tab);
    const host = "host" in pane ? savedById.get(pane.host.id) ?? pane.host : undefined;
    const title = tabTitle(tab, t, ordinals.get(tab.id)!, titleSource, privacyMode);
    const status = tabStatus(tab);
    const hasUnreadOutput = !active && unread.has(tab.id);
    const bellRang = flashing.has(tab.id);
    const panes = tabPanes(tab);
    const logging = panes.some(({ id }) => outputs.get(id)?.log);
    const recording = panes.some(({ id }) => outputs.get(id)?.recording);
    const agentShared = sharesTerminal(tab);
    const details = [
      status && t(`tabs.status.${status}`),
      tab.locked && t("tabs.locked"),
      hasUnreadOutput && t("tabs.unreadOutput"),
      bellRang && t("tabs.terminalBell"),
      logging && t("terminal.log.active"),
      recording && t("terminal.recording.active"),
      agentShared && t("agentAccess.sharedTerminal"),
    ].filter(Boolean).join(", ");
    const label = details ? `${title} (${details})` : title;
    const TabIcon = tab.layout.type === "split"
      ? tab.layout.orientation === "horizontal" ? Columns2 : Rows2
      : kindIcons[pane.kind];
    const hue = tabHue(tab, host);
    return (
      <DraggableTab
        key={tab.id}
        id={tab.id}
        hidden={hidden}
        className={cn(
          "group/tab relative flex h-7 shrink-0 items-center rounded-lg border transition-colors data-dragging:opacity-50",
          vertical ? "w-full min-w-0" : "max-w-52 min-w-28",
          active
            ? "bg-surface text-foreground border-border"
            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground active:bg-accent border-transparent",
        )}
        onAuxClick={() => !tab.locked && onTabAction({ type: "close", id: tab.id })}
        menu={<TabMenu
          tab={tab}
          title={title}
          vertical={vertical}
          onSaveTemporaryHost={onSaveTemporaryHost}
          onAction={(action) => {
            if (vertical && action.type === "closeRight") {
              const index = ordered.findIndex(({ id }) => id === tab.id);
              onTabAction({ ...action, after: ordered.slice(index + 1).map(({ id }) => id) });
            } else {
              onTabAction(action);
            }
          }}
        />}
      >
        {drop?.id === tab.id && dragging !== tab.id && (
          <span
            aria-hidden
            className={cn(
              "bg-ring absolute rounded-full",
              vertical
                ? cn("inset-x-1 h-0.5", drop.side === "before" ? "-top-0.5" : "-bottom-0.5")
                : cn("inset-y-1 w-0.5", drop.side === "before" ? "-left-0.5" : "-right-0.5"),
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
          tabIndex={!hidden && tab.id === focusableTabId ? 0 : -1}
          title={label}
          className={cn(
            "focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg outline-none focus-visible:ring-[3px]",
            compact ? "justify-center" : cn("pr-1 pl-2.5", grouped && "pl-4"),
          )}
          onClick={() => onActivate(tab.id)}
        >
          {host ? (
            <HostMonogram host={{ ...host, name: workspaceHostName(host, t, privacyMode) }}>
              {status && <span
                data-status={status}
                className={cn(
                  "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1",
                  active ? "ring-surface" : "ring-background",
                  statusDot[status],
                  status === "connecting" && "motion-safe:animate-pulse",
                )}
              />}
            </HostMonogram>
          ) : (
            <TabIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
          )}
          {!compact && <span className="truncate">{title}</span>}
          {hasUnreadOutput && <span aria-hidden data-unread-output className={cn(
            "bg-primary size-1.5 shrink-0 rounded-full",
            compact && "absolute top-1 right-1",
          )} />}
          {logging && <FileText aria-hidden className={cn(
            "text-warning size-3 shrink-0",
            compact && "absolute bottom-0.5 left-1 size-2.5",
          )} />}
          {recording && <CircleDot aria-hidden className={cn(
            "text-primary size-3 shrink-0",
            compact && "absolute top-0.5 left-1 size-2.5",
          )} />}
          {agentShared && <Cable aria-hidden data-agent-access className={cn(
            "text-primary size-3 shrink-0",
            compact && "absolute bottom-0.5 right-1 size-2.5",
          )} />}
          {bellRang && <span aria-hidden data-terminal-bell className="pointer-events-none absolute inset-0 rounded-lg" />}
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
          <span aria-hidden className={cn(
            "text-muted-foreground grid shrink-0 place-items-center",
            compact ? "absolute right-0.5 bottom-0.5 size-3" : "mr-1 size-5",
          )}>
            <Lock className={compact ? "size-2.5" : "size-3.5"} />
          </span>
        ) : (
          <button
            type="button"
            tabIndex={-1}
            aria-label={t("tabs.close", { title })}
            className={cn(
              "text-muted-foreground hover:bg-accent hover:text-foreground active:bg-accent/70 focus-visible:ring-ring/50 grid shrink-0 place-items-center rounded-md outline-none focus-visible:opacity-100 focus-visible:ring-2",
              compact ? "absolute right-0 bottom-0 size-4" : "mr-1 size-5",
              (compact || !active) && "opacity-0 group-hover/tab:opacity-100",
            )}
            onClick={() => onTabAction({ type: "close", id: tab.id })}
          >
            <X className={compact ? "size-3" : "size-3.5"} aria-hidden />
          </button>
        )}
      </DraggableTab>
    );
  }

  return (
    <div className={cn(
      "flex h-full min-w-0 flex-1 gap-1",
      vertical ? "min-h-0 flex-col" : "items-center",
    )}>
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
          id="workspace-tabs"
          role="tablist"
          aria-label={t("tabs.listLabel")}
          aria-orientation={tabOrientation}
          className={cn(
            "flex min-w-0 gap-1 [scrollbar-width:none]",
            vertical ? "min-h-0 flex-1 flex-col overflow-y-auto" : "items-center overflow-x-auto",
          )}
          onKeyDown={onKeyDown}
        >
          {groups.flatMap((group) => {
            if (group.type === "tab") return [renderTab(group.tab)];
            const closed = collapsed.has(group.host.id);
            const hasUnread = closed && group.tabs.some(({ id }) => id !== activeId && unread.has(id));
            const bellRang = closed && group.tabs.some(({ id }) => flashing.has(id));
            const agentShared = closed && group.tabs.some(sharesTerminal);
            const current = closed && group.tabs.some(({ id }) => id === activeId);
            const host = savedById.get(group.host.id) ?? group.host;
            const name = workspaceHostName(host, t, privacyMode);
            const title = t("tabs.hostGroup", { name });
            const label = [
              title,
              hasUnread && t("tabs.unreadOutput"),
              bellRang && t("tabs.terminalBell"),
              agentShared && t("agentAccess.sharedTerminal"),
            ].filter(Boolean).join(", ");
            return [
              <button
                key={`host:${group.host.id}`}
                type="button"
                aria-expanded={!closed}
                aria-current={current || undefined}
                aria-controls={group.tabs.map(({ id }) => tabId(id)).join(" ")}
                aria-label={label}
                title={label}
                className={cn(
                  "hover:bg-accent focus-visible:ring-ring/50 relative flex h-7 w-full min-w-0 shrink-0 items-center gap-1 rounded-lg text-xs outline-none focus-visible:ring-[3px]",
                  current ? "bg-surface text-foreground" : "text-muted-foreground",
                  compact ? "justify-center gap-0.5" : "px-2",
                )}
                onClick={() => toggleHost(group.host.id)}
              >
                <ChevronRight aria-hidden className={cn("shrink-0", compact ? "size-3" : "size-3.5", !closed && "rotate-90")} />
                <HostMonogram host={{ ...host, name }} />
                {!compact && <span className="truncate">{name}</span>}
                {hasUnread && <span aria-hidden data-unread-output className={cn(
                  "bg-primary size-1.5 shrink-0 rounded-full",
                  compact && "absolute top-1 right-1",
                )} />}
                {agentShared && <Cable aria-hidden className={cn(
                  "text-primary size-3 shrink-0",
                  compact && "absolute bottom-0.5 right-1 size-2.5",
                )} />}
                {bellRang && <span aria-hidden data-terminal-bell className="pointer-events-none absolute inset-0 rounded-lg" />}
              </button>,
              ...group.tabs.map((tab) => renderTab(tab, true, closed)),
            ];
          })}
        </div>
      </DndContext>
      <div className={cn(
        vertical ? "flex shrink-0 items-center justify-center gap-1" : "contents",
        compact && "flex-col",
      )}>
        <div className={cn("flex shrink-0 items-center", compact && "flex-col")}>
          <IconButton
            label={t("tabs.newLocalTerminal")}
            shortcut={shortcutLabel("newTab", shortcuts)}
            tooltipSide={vertical ? "right" : "bottom"}
            onClick={onNewLocalTerminal}
          >
            <Plus />
          </IconButton>
          <LocalShellMenu vertical={vertical} onSelect={onNewLocalShell} />
        </div>
        {!vertical && <div data-tauri-drag-region className="h-full min-w-4 flex-1" />}
        {selected && canSplit(selected) && (
          <>
            <IconButton
              label={t("tabs.splitRight")}
              shortcut={shortcutLabel("splitRight", shortcuts)}
              tooltipSide={vertical ? "right" : "bottom"}
              onClick={() => onSplit("horizontal")}
            >
              <Columns2 />
            </IconButton>
            <IconButton
              label={t("tabs.splitDown")}
              shortcut={shortcutLabel("splitDown", shortcuts)}
              tooltipSide={vertical ? "right" : "bottom"}
              onClick={() => onSplit("vertical")}
            >
              <Rows2 />
            </IconButton>
          </>
        )}
        {vertical && (
          <IconButton
            label={t(compact ? "tabs.showTitles" : "tabs.showIconsOnly")}
            tooltipSide="right"
            onClick={toggleCompact}
          >
            {compact ? <PanelLeftOpen /> : <PanelLeftClose />}
          </IconButton>
        )}
      </div>
    </div>
  );
}

/** One tab: draggable by its body (after a 4px move, so clicks still activate) and a drop target. */
function DraggableTab({
  id,
  className,
  hidden,
  onAuxClick,
  menu,
  children,
}: {
  id: string;
  hidden: boolean;
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
          hidden={hidden}
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
