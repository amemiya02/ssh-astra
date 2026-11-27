import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { PortForwardsPanel } from "@/features/forwards/PortForwardsPanel";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { LocalTerminalView } from "@/features/terminal/LocalTerminalView";
import { SftpWorkspace } from "@/features/files/SftpWorkspace";
import { terminalCwds } from "@/features/files/terminalCwds";
import { RemoteTerminalView } from "@/features/terminal/RemoteTerminalView";
import { cn } from "@/lib/utils";
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
}

/**
 * Every open tab and pane stays mounted (a Terminal keeps its shell and scrollback while
 * hidden); only the active tab is shown. A split tab lays its panes out in a resizable group,
 * which is always rendered so splitting or closing a pane never remounts its neighbours.
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

type PaneCallbacks = Omit<TabPanelsProps, "tabs" | "activeId">;

function SplitPanes({ tab, active, ...callbacks }: { tab: Tab; active: boolean } & PaneCallbacks) {
  const { t } = useTranslation();
  const split = tab.panes.length > 1;
  return (
    <ResizablePanelGroup orientation={tab.orientation}>
      {tab.panes.map((pane, index) => {
        const focused = pane.id === tab.activePaneId;
        return (
          <Fragment key={pane.id}>
            {index > 0 && <ResizableHandle className="focus-visible:ring-0" />}
            <ResizablePanel id={pane.id} minSize="120px">
              <div
                role={split ? "group" : undefined}
                aria-label={split ? t("tabs.pane", { index: index + 1, count: tab.panes.length }) : undefined}
                className={cn("relative h-full transition-opacity", split && !focused && "opacity-70")}
                onFocusCapture={() => {
                  if (!focused) callbacks.onFocusPane(pane.id);
                }}
                onPointerDown={() => {
                  if (!focused) callbacks.onFocusPane(pane.id);
                }}
              >
                <PaneContent pane={pane} active={active && focused} {...callbacks} />
                {/* An overlay, not the pane's own ring: a Terminal's canvas paints over an inset shadow. The dim on the others is real but faint on a dark theme. */}
                {split && focused && (
                  <span aria-hidden data-pane-focus className="ring-primary/50 pointer-events-none absolute inset-0 z-10 ring-1 ring-inset" />
                )}
              </div>
            </ResizablePanel>
          </Fragment>
        );
      })}
    </ResizablePanelGroup>
  );
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
