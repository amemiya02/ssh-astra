import { SquareTerminal } from "lucide-react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { PortForwardsPanel } from "@/features/forwards/PortForwardsPanel";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { LocalTerminalView } from "@/features/terminal/LocalTerminalView";
import { terminalCwds } from "@/features/files/terminalCwds";
import { RemoteTerminalView } from "@/features/terminal/RemoteTerminalView";
import { cn } from "@/lib/utils";
import { tabId, tabPanelId, type ConnectionStatus, type Pane, type Tab } from "./tabs";

interface TabPanelsProps {
  tabs: Tab[];
  activeId: string | null;
  onNewLocalTerminal(): void;
  onFocusPane(paneId: string): void;
  /** A program in the pane set its title (empty string clears it). */
  onTitleChange(paneId: string, title: string): void;
  onStatusChange(paneId: string, status: ConnectionStatus): void;
}

/**
 * Every open tab and pane stays mounted (a Terminal keeps its shell and scrollback while
 * hidden); only the active tab is shown. A split tab lays its panes out in a resizable group,
 * which is always rendered so splitting or closing a pane never remounts its neighbours.
 */
export function TabPanels({ tabs, activeId, onNewLocalTerminal, ...paneProps }: TabPanelsProps) {
  const { t } = useTranslation();

  if (tabs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <SquareTerminal className="text-muted-foreground size-6" aria-hidden />
        <div className="space-y-1">
          <p className="text-foreground font-medium">{t("workspace.emptyTitle")}</p>
          <p className="text-muted-foreground max-w-72 text-balance">{t("workspace.emptyBody")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onNewLocalTerminal}>
          {t("tabs.newLocalTerminal")}
        </Button>
      </div>
    );
  }

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

type PaneCallbacks = Omit<TabPanelsProps, "tabs" | "activeId" | "onNewLocalTerminal">;

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
                className={cn("h-full transition-opacity", split && !focused && "opacity-70")}
                onFocusCapture={() => {
                  if (!focused) callbacks.onFocusPane(pane.id);
                }}
                onPointerDown={() => {
                  if (!focused) callbacks.onFocusPane(pane.id);
                }}
              >
                <PaneContent pane={pane} active={active && focused} {...callbacks} />
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
}: { pane: Pane; active: boolean } & PaneCallbacks) {
  switch (pane.kind) {
    case "local-terminal":
      return <LocalTerminalView active={active} onTitleChange={(title) => onTitleChange(pane.id, title)} />;
    case "remote-terminal":
      return (
        <RemoteTerminalView
          host={pane.host}
          active={active}
          onTitleChange={(title) => onTitleChange(pane.id, title)}
          onStatusChange={(status) => onStatusChange(pane.id, status)}
          onCwd={(path) => terminalCwds.report(pane.id, path)}
          onTerminal={(id) => terminalCwds.attach(pane.id, id)}
        />
      );
    case "settings":
      return <SettingsPage />;
    case "port-forwards":
      return <PortForwardsPanel host={pane.host} active={active} />;
  }
}
