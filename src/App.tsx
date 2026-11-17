import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FilePanelContent, type FilePanelPane } from "@/features/files/FilePanelContent";
import { forwardsStore, runningForwards, useForwards } from "@/features/forwards/forwardsStore";
import { describeForward } from "@/features/forwards/forwardForm";
import { activeConnections, runningRules } from "@/features/forwards/status";
import { useHosts } from "@/features/hosts/hostsStore";
import { HostsPanel } from "@/features/hosts/HostsPanel";
import { CommandPalette, type PaletteTab } from "@/features/palette/CommandPalette";
import { usePaletteActions, type PaletteAction } from "@/features/palette/palette-actions";
import { rememberHostOpened } from "@/features/palette/recent-hosts";
import { AppShell } from "@/features/shell/AppShell";
import { isSettingsShortcut, settingsShortcut } from "@/features/shell/shortcuts";
import { currentPlatform, shortcutLabel, type WorkspaceCommand } from "@/features/workspace/shortcuts";
import { TabPanels } from "@/features/workspace/TabPanels";
import { TabStrip } from "@/features/workspace/TabStrip";
import {
  activePane,
  activeTab,
  connectedHosts,
  emptyTabs,
  newPane,
  tabTitle,
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
  const openRemoteTerminal = useCallback(
    (host: Host) => {
      rememberHostOpened(host.id);
      openTab({ kind: "remote-terminal", host });
    },
    [openTab],
  );
  const openSettings = useCallback(() => openTab({ kind: "settings" }), [openTab]);
  const openForwards = useCallback((host: Host) => openTab({ kind: "port-forwards", host }), [openTab]);
  // Port forward states are pushed by the backend for the app's lifetime.
  useEffect(() => {
    void forwardsStore.getState().watch();
  }, []);
  // Capture phase, so the shortcut works while a Terminal has focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSettingsShortcut(event)) return;
      event.preventDefault();
      openSettings();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [openSettings]);
  const retitle = useCallback((paneId: string, title: string) => dispatch({ type: "retitle", paneId, title }), []);
  const setStatus = useCallback(
    (paneId: string, status: ConnectionStatus) => dispatch({ type: "status", paneId, status }),
    [],
  );

  /**
   * A new pane beside the focused one, running the same kind of Terminal (the same Host's shares its
   * Connection); beside Settings, a Local terminal.
   */
  const split = (orientation: SplitOrientation) => {
    const tab = activeTab(state);
    if (!tab) return;
    const pane = activePane(tab);
    const kind: PaneKind = pane.kind === "remote-terminal" ? { kind: pane.kind, host: pane.host } : localTerminal;
    dispatch({ type: "split", orientation, pane: newPane(kind) });
  };

  // The palette's split actions run the latest `split`, without re-registering on every change.
  const splitRef = useRef(split);
  useEffect(() => {
    splitRef.current = split;
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const activateTab = useCallback((id: string) => dispatch({ type: "activate", id }), []);
  const paletteTabs = useMemo(
    (): PaletteTab[] =>
      tabs.map((tab, index) => {
        const kind = activePane(tab).kind;
        const ordinal = tabs.slice(0, index + 1).filter((other) => activePane(other).kind === kind).length;
        return { id: tab.id, title: tabTitle(tab, t, ordinal) };
      }),
    [tabs, t],
  );
  usePaletteActions(
    useMemo(
      (): PaletteAction[] => [
        {
          id: "terminal.newLocal",
          title: t("tabs.newLocalTerminal"),
          shortcut: shortcutLabel("newTab", platform),
          run: openLocalTerminal,
        },
        {
          id: "workspace.splitRight",
          title: t("tabs.splitRight"),
          shortcut: shortcutLabel("splitRight", platform),
          run: () => splitRef.current("horizontal"),
        },
        {
          id: "workspace.splitDown",
          title: t("tabs.splitDown"),
          shortcut: shortcutLabel("splitDown", platform),
          run: () => splitRef.current("vertical"),
        },
        {
          id: "settings.open",
          title: t("palette.actions.openSettings"),
          keywords: [t("palette.keywords.preferences")],
          shortcut: settingsShortcut,
          run: openSettings,
        },
      ],
      [t, openLocalTerminal, openSettings],
    ),
  );

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
      case "openPalette":
        return setPaletteOpen((open) => !open);
      case "goToTab": {
        const target = tabs.at(command.index);
        if (target) dispatch({ type: "activate", id: target.id });
        return;
      }
    }
  });

  const hosts = useHosts((s) => s.tree.hosts);
  const forwardStates = useForwards((s) => s.states);
  const running = runningForwards({ states: forwardStates });
  const connected = activeConnections(connectedHosts(state), running, hosts);
  const forwards = runningRules(running, hosts).map(({ rule }) => {
    const { from, to } = describeForward(rule);
    return `${from} → ${to}`;
  });
  const focused = activeTab(state);
  const focusedPane = focused && activePane(focused);
  const filePanelPane: FilePanelPane | undefined =
    focusedPane?.kind === "remote-terminal"
      ? { id: focusedPane.id, host: focusedPane.host, status: focusedPane.status ?? "connecting" }
      : undefined;
  const remotePaneIds = tabs.flatMap((tab) =>
    tab.panes.filter((pane) => pane.kind === "remote-terminal").map((pane) => pane.id),
  );

  return (
    <>
      <AppShell
        sidebar={
          <HostsPanel
            onOpen={openRemoteTerminal}
            onOpenForwards={openForwards}
            onOpenLocalTerminal={openLocalTerminal}
          />
        }
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
        filePanel={<FilePanelContent pane={filePanelPane} remotePaneIds={remotePaneIds} />}
        onOpenSettings={openSettings}
        status={
          <span role="status" className="flex min-w-0 items-center gap-3.5">
            <span className="truncate">
              {connected.length === 0
                ? t("status.noConnections")
                : t("status.connectedTo", { hosts: connected.map((host) => host.name).join(", ") })}
            </span>
            {forwards.length > 0 && (
              <span className="truncate">{t("status.forwards", { list: forwards.join(", ") })}</span>
            )}
          </span>
        }
      />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        tabs={paletteTabs}
        onOpenHost={openRemoteTerminal}
        onActivateTab={activateTab}
      />
    </>
  );
}
