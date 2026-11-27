import { useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { PortForwardsPanel } from "@/features/forwards/PortForwardsPanel";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { GlobalTransfersPane } from "@/features/transfers/GlobalTransfersPane";
import { LocalTerminalView } from "@/features/terminal/LocalTerminalView";
import { SftpWorkspace } from "@/features/files/SftpWorkspace";
import { terminalCwds } from "@/features/files/terminalCwds";
import { TerminalPaneMenuContext } from "@/features/terminal/terminal-pane-menu";
import { RemoteTerminalView } from "@/features/terminal/RemoteTerminalView";
import type { Host } from "@/lib/ipc/hosts";
import { cn } from "@/lib/utils";
import { BroadcastPaneContext, isBroadcastRecipient, type Broadcast } from "./broadcast";
import { PaneDivider } from "./PaneDivider";
import { positionPanes, resizePaneLayout, type PaneBounds, type SplitResize } from "./pane-layout";
import { TabActivityContext, type TabActivity } from "./tab-activity";
import { canSplit, nextRestoreConnection, tabId, tabPanelId, type ConnectionStatus, type Pane, type ReconnectProgress, type SplitOrientation, type Tab } from "./tabs";

interface TabPanelsProps {
  activity: TabActivity;
  broadcast?: Broadcast;
  tabs: Tab[];
  activeId: string | null;
  /** Home, drawn for the Home tab (or when no tab is open). `active`: it is the pane shown. */
  renderHome(active: boolean): ReactNode;
  onFocusPane(paneId: string): void;
  onSplitPane(paneId: string, orientation: SplitOrientation): void;
  onClosePane(paneId: string): void;
  onEditHost(host: Host): void;
  onConnectRestoredPane(paneId: string): void;
  /** A program in the pane set its title (empty string clears it). */
  onTitleChange(paneId: string, title: string): void;
  onLocalCwd(paneId: string, cwd: string): void;
  onStatusChange(paneId: string, status: ConnectionStatus, reconnecting?: ReconnectProgress): void;
  onResizeSplit(tabId: string, resize: SplitResize): void;
}

/**
 * Every open tab and pane stays mounted (a Terminal keeps its shell and scrollback while
 * hidden); only the active tab is shown. A tree determines positions, while the pane DOM
 * stays keyed directly under its tab so edits to the tree cannot remount a neighbour.
 */
export function TabPanels({ tabs, activeId, activity, ...paneProps }: TabPanelsProps) {
  // Closing the last tab leaves Home, never an empty stage.
  if (tabs.length === 0) return <div className="absolute inset-0">{paneProps.renderHome(true)}</div>;

  const nextConnection = nextRestoreConnection(tabs);
  return tabs.map((tab) => {
    const active = tab.id === activeId;
    return (
      <div
        key={tab.id}
        id={tabPanelId(tab.id)}
        role="tabpanel"
        aria-labelledby={tabId(tab.id)}
        hidden={!active}
        className="absolute inset-0"
      >
        <TabActivityContext.Provider value={{ activity, tabId: tab.id }}>
          <SplitPanes tab={tab} active={active} nextConnection={nextConnection} {...paneProps} />
        </TabActivityContext.Provider>
      </div>
    );
  });
}

type PaneCallbacks = Omit<TabPanelsProps, "activity" | "broadcast" | "tabs" | "activeId" | "onResizeSplit">;

function SplitPanes({ broadcast, tab, active, nextConnection, onResizeSplit, ...callbacks }: {
  tab: Tab;
  active: boolean;
  nextConnection: string | undefined;
} & Omit<TabPanelsProps, "activity" | "tabs" | "activeId">) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<{ id: string; fraction: number } | null>(null);
  const maximized = tab.paneMaximized;
  const saved = positionPanes(tab.layout);
  const previewDivider = !maximized && preview && saved.dividers.find((divider) => divider.id === preview.id);
  // The drag ends when its divider disappears.
  if (preview && !previewDivider) setPreview(null);
  const { panes, dividers } = preview && previewDivider
    ? positionPanes(resizePaneLayout(tab.layout, { ...previewDivider, fraction: preview.fraction }))
    : saved;
  const split = panes.length > 1;
  return (
    <div className="absolute inset-0 overflow-hidden">
      {panes.map(({ pane, bounds }, index) => {
        const focused = pane.id === tab.activePaneId;
        return (
          <div
            key={pane.id}
            id={`pane-${pane.id}`}
            role={split ? "group" : undefined}
            aria-label={split ? t("tabs.pane", { index: index + 1, count: panes.length }) : undefined}
            hidden={maximized && !focused}
            style={paneStyle(maximized && focused ? { left: 0, top: 0, width: 1, height: 1 } : bounds)}
            className={cn("absolute overflow-hidden transition-opacity", split && !focused && "opacity-70")}
            onFocusCapture={(event) => {
              // A startup sign-in dialog can belong to a pane in a different tab.
              if (!focused && event.target instanceof Node && event.currentTarget.contains(event.target)) callbacks.onFocusPane(pane.id);
            }}
            onPointerDown={(event) => {
              if (!focused && event.target instanceof Node && event.currentTarget.contains(event.target)) callbacks.onFocusPane(pane.id);
            }}
          >
            <BroadcastPaneContext.Provider value={broadcast && { broadcast, tabId: tab.id, paneId: pane.id }}>
              <TerminalPaneMenuContext.Provider value={{
                hostId: pane.kind === "remote-terminal" ? pane.host.id : undefined,
                split: canSplit(tab, pane.id) ? (orientation) => callbacks.onSplitPane(pane.id, orientation) : undefined,
              }}>
                <PaneContent pane={pane} active={active && focused} visible={active && (!maximized || focused)}
                  autoConnect={pane.id === nextConnection} {...callbacks} />
              </TerminalPaneMenuContext.Provider>
            </BroadcastPaneContext.Provider>
            {broadcast && <BroadcastMarker broadcast={broadcast} paneId={pane.id} />}
            {/* A Terminal canvas can paint over the pane's inset shadow. Draw the focus ring on top. */}
            {split && focused && !maximized && (
              <span aria-hidden data-pane-focus className="ring-primary/50 pointer-events-none absolute inset-0 z-10 ring-1 ring-inset" />
            )}
          </div>
        );
      })}
      {!maximized && dividers.map((divider) => (
        <PaneDivider
          key={divider.id}
          divider={divider}
          onPreview={(fraction) => setPreview(fraction === null ? null : { id: divider.id, fraction })}
          onResize={(resize) => onResizeSplit(tab.id, resize)}
        />
      ))}
    </div>
  );
}

function BroadcastMarker({ broadcast, paneId }: { broadcast: Broadcast; paneId: string }) {
  const receives = useStore(broadcast.store, (snapshot) => isBroadcastRecipient(snapshot, paneId));
  const { t } = useTranslation();
  if (!receives) return null;
  return (
    <span
      data-broadcast-recipient
      className="border-warning pointer-events-none absolute inset-0.5 z-10 border border-dashed"
    >
      <span className="sr-only">{t("broadcast.recipient")}</span>
    </span>
  );
}

function paneStyle({ left, top, width, height }: PaneBounds): CSSProperties {
  return { left: `${left * 100}%`, top: `${top * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` };
}

function PaneContent({
  pane,
  active,
  visible,
  autoConnect,
  onConnectRestoredPane,
  onTitleChange,
  onLocalCwd,
  onStatusChange,
  onClosePane,
  onEditHost,
  renderHome,
}: { pane: Pane; active: boolean; visible: boolean; autoConnect: boolean } & PaneCallbacks) {
  if (pane.restoreConnection && !autoConnect && (pane.kind === "remote-terminal" || pane.kind === "sftp")) {
    return <RestoredConnection
      host={pane.host.name}
      onConnect={pane.restoreConnection === "manual" ? () => onConnectRestoredPane(pane.id) : undefined}
    />;
  }

  switch (pane.kind) {
    case "home":
      return renderHome(active);
    case "local-terminal":
      return (
        <LocalTerminalView
          active={active}
          visible={visible}
          initialCwd={pane.cwd}
          shellId={pane.shellId}
          onTitleChange={(title) => onTitleChange(pane.id, title)}
          onCwd={(cwd) => onLocalCwd(pane.id, cwd)}
        />
      );
    case "remote-terminal":
      return (
        <RemoteTerminalView
          paneId={pane.id}
          host={pane.host}
          initialCwd={pane.initialCwd}
          onClose={() => onClosePane(pane.id)}
          onEditHost={() => onEditHost(pane.host)}
          active={active}
          visible={visible}
          showPrompts={active || autoConnect}
          onTitleChange={(title) => onTitleChange(pane.id, title)}
          onStatusChange={(status, reconnecting) => onStatusChange(pane.id, status, reconnecting)}
          onCwd={(path) => terminalCwds.report(pane.id, path)}
          onTerminal={(id) => terminalCwds.attach(pane.id, id)}
        />
      );
    case "sftp":
      return <SftpWorkspace id={pane.id} host={pane.host} active={active} showPrompts={active || autoConnect} onStatusChange={onStatusChange} />;
    case "settings":
      return <SettingsPage />;
    case "transfers":
      return <GlobalTransfersPane visible={active} />;
    case "port-forwards":
      return <PortForwardsPanel host={pane.host} active={active} />;
  }
}

function RestoredConnection({ host, onConnect }: { host: string; onConnect?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid h-full place-content-center justify-items-center gap-3 overflow-auto p-4 text-center">
      <p className="text-muted-foreground text-sm" role="status">
        {t(onConnect ? "connect.restored.disconnected" : "connect.restored.waiting", { host })}
      </p>
      {onConnect && <Button variant="outline" size="sm" onClick={onConnect}>{t("connect.restored.connect")}</Button>}
    </div>
  );
}
