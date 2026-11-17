import { useCallback, useReducer } from "react";
import { useTranslation } from "react-i18next";
import { FilePanel } from "@/features/files/FilePanel";
import { HostsPanel } from "@/features/hosts/HostsPanel";
import { AppShell } from "@/features/shell/AppShell";
import { currentPlatform, type WorkspaceCommand } from "@/features/workspace/shortcuts";
import { TabPanels } from "@/features/workspace/TabPanels";
import { TabStrip } from "@/features/workspace/TabStrip";
import {
  activePane,
  activeTab,
  connectedHosts,
  emptyTabs,
  newPane,
  tabsReducer,
  type ConnectionStatus,
  type PaneKind,
  type SplitOrientation,
  type TabsState,
} from "@/features/workspace/tabs";
import { useWorkspaceShortcuts } from "@/features/workspace/use-workspace-shortcuts";
import type { Host } from "@/lib/ipc/hosts";

const platform = currentPlatform();
const localTerminal: PaneKind = { kind: "local-terminal" };

function initialTabs(): TabsState {
  return tabsReducer(emptyTabs, { type: "open", tabId: crypto.randomUUID(), pane: newPane(localTerminal) });
}

/**
 * Composes the main window. Each slot of `AppShell` is owned by a feature:
 * Host list (features/hosts), tabs and splits (features/workspace), File panel (features/files).
 */
export function App() {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(tabsReducer, undefined, initialTabs);
  const { tabs, activeId } = state;

  const openTab = useCallback(
    (kind: PaneKind) => dispatch({ type: "open", tabId: crypto.randomUUID(), pane: newPane(kind) }),
    [],
  );
  const openLocalTerminal = useCallback(() => openTab(localTerminal), [openTab]);
  const openRemoteTerminal = useCallback((host: Host) => openTab({ kind: "remote-terminal", host }), [openTab]);
  const retitle = useCallback((paneId: string, title: string) => dispatch({ type: "retitle", paneId, title }), []);
  const setStatus = useCallback(
    (paneId: string, status: ConnectionStatus) => dispatch({ type: "status", paneId, status }),
    [],
  );

  /** A new pane beside the focused one, running the same kind of Terminal (the same Host's shares its Connection). */
  const split = (orientation: SplitOrientation) => {
    const tab = activeTab(state);
    if (!tab) return;
    const pane = activePane(tab);
    const kind: PaneKind = pane.kind === "remote-terminal" ? { kind: pane.kind, host: pane.host } : localTerminal;
    dispatch({ type: "split", orientation, pane: newPane(kind) });
  };

  useWorkspaceShortcuts(platform, (command: WorkspaceCommand) => {
    const tab = activeTab(state);
    switch (command.type) {
      case "newTab":
        return openLocalTerminal();
      case "closePane":
        if (tab) dispatch({ type: "closePane", paneId: tab.activePaneId });
        return;
      case "split":
        return split(command.orientation);
      case "cycleTab":
        return dispatch({ type: "cycle", step: command.step });
      case "cyclePane":
        return dispatch({ type: "cyclePane", step: command.step });
      case "moveTab":
        if (tab) dispatch({ type: "move", id: tab.id, to: tabs.indexOf(tab) + command.step });
        return;
      case "goToTab": {
        const target = tabs.at(command.index);
        if (target) dispatch({ type: "activate", id: target.id });
        return;
      }
    }
  });

  const connected = connectedHosts(state);

  return (
    <AppShell
      sidebar={<HostsPanel onOpen={openRemoteTerminal} onOpenLocalTerminal={openLocalTerminal} />}
      tabs={
        <TabStrip
          tabs={tabs}
          activeId={activeId}
          platform={platform}
          onActivate={(id) => dispatch({ type: "activate", id })}
          onClose={(id) => dispatch({ type: "close", id })}
          onMove={(id, to) => dispatch({ type: "move", id, to })}
          onNewLocalTerminal={openLocalTerminal}
          onSplit={split}
        />
      }
      workspace={
        <TabPanels
          tabs={tabs}
          activeId={activeId}
          onNewLocalTerminal={openLocalTerminal}
          onFocusPane={(paneId) => dispatch({ type: "focusPane", paneId })}
          onTitleChange={retitle}
          onStatusChange={setStatus}
        />
      }
      filePanel={<FilePanel />}
      status={
        <span role="status" className="truncate">
          {connected.length === 0
            ? t("status.noConnections")
            : t("status.connectedTo", { hosts: connected.map((host) => host.name).join(", ") })}
        </span>
      }
    />
  );
}
