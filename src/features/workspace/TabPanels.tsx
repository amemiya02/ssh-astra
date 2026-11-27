import { useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PortForwardsPanel } from "@/features/forwards/PortForwardsPanel";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { LocalTerminalView } from "@/features/terminal/LocalTerminalView";
import { SftpWorkspace } from "@/features/files/SftpWorkspace";
import { terminalCwds } from "@/features/files/terminalCwds";
import { RemoteTerminalView } from "@/features/terminal/RemoteTerminalView";
import { cn } from "@/lib/utils";
import { PaneDivider } from "./PaneDivider";
import { positionPanes, resizePaneLayout, type PaneBounds, type SplitResize } from "./pane-layout";
import { tabId, tabPanelId, type ConnectionStatus, type Pane, type ReconnectProgress, type Tab } from "./tabs";

interface TabPanelsProps {
  tabs: Tab[];
  activeId: string | null;
  /** Home, drawn for the Home tab (or when no tab is open). `active`: it is the pane shown. */
  renderHome(active: boolean): ReactNode;
  onFocusPane(paneId: string): void;
  /** A program in the pane set its title (empty string clears it). */
  onTitleChange(paneId: string, title: string): void;
  onStatusChange(paneId: string, status: ConnectionStatus, reconnecting?: ReconnectProgress): void;
  onResizeSplit(tabId: string, resize: SplitResize): void;
}

/**
 * Every open tab and pane stays mounted (a Terminal keeps its shell and scrollback while
 * hidden); only the active tab is shown. A tree determines positions, while the pane DOM
 * stays keyed directly under its tab so edits to the tree cannot remount a neighbour.
 */
export function TabPanels({ tabs, activeId, ...paneProps }: TabPanelsProps) {
  // Closing the last tab leaves Home, never an empty stage.
  if (tabs.length === 0) return <div className="absolute inset-0">{paneProps.renderHome(true)}</div>;

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
        <SplitPanes tab={tab} active={active} {...paneProps} />
      </div>
    );
  });
}

type PaneCallbacks = Omit<TabPanelsProps, "tabs" | "activeId" | "onResizeSplit">;

function SplitPanes({ tab, active, onResizeSplit, ...callbacks }: { tab: Tab; active: boolean } & Omit<TabPanelsProps, "tabs" | "activeId">) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<{ id: string; fraction: number } | null>(null);
  const saved = positionPanes(tab.layout);
  const previewDivider = preview && saved.dividers.find((divider) => divider.id === preview.id);
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
            style={paneStyle(bounds)}
            className={cn("absolute overflow-hidden transition-opacity", split && !focused && "opacity-70")}
            onFocusCapture={() => {
              if (!focused) callbacks.onFocusPane(pane.id);
            }}
            onPointerDown={() => {
              if (!focused) callbacks.onFocusPane(pane.id);
            }}
          >
            <PaneContent pane={pane} active={active && focused} {...callbacks} />
            {/* A Terminal canvas can paint over the pane's inset shadow. Draw the focus ring on top. */}
            {split && focused && (
              <span aria-hidden data-pane-focus className="ring-primary/50 pointer-events-none absolute inset-0 z-10 ring-1 ring-inset" />
            )}
          </div>
        );
      })}
      {dividers.map((divider) => (
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

function paneStyle({ left, top, width, height }: PaneBounds): CSSProperties {
  return { left: `${left * 100}%`, top: `${top * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` };
}

function PaneContent({
  pane,
  active,
  onTitleChange,
  onStatusChange,
  renderHome,
}: { pane: Pane; active: boolean } & PaneCallbacks) {
  switch (pane.kind) {
    case "home":
      return renderHome(active);
    case "local-terminal":
      return <LocalTerminalView active={active} onTitleChange={(title) => onTitleChange(pane.id, title)} />;
    case "remote-terminal":
      return (
        <RemoteTerminalView
          paneId={pane.id}
          host={pane.host}
          active={active}
          onTitleChange={(title) => onTitleChange(pane.id, title)}
          onStatusChange={(status, reconnecting) => onStatusChange(pane.id, status, reconnecting)}
          onCwd={(path) => terminalCwds.report(pane.id, path)}
          onTerminal={(id) => terminalCwds.attach(pane.id, id)}
        />
      );
    case "sftp":
      return <SftpWorkspace id={pane.id} host={pane.host} active={active} onStatusChange={onStatusChange} />;
    case "settings":
      return <SettingsPage />;
    case "port-forwards":
      return <PortForwardsPanel host={pane.host} active={active} />;
  }
}
