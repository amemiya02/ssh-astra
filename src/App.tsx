import { isTauri } from "@tauri-apps/api/core";
import { Server } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { connectionsStore, useConnections } from "@/features/connect/connectionsStore";
import { hostConnections } from "@/features/connect/hostConnection";
import { CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { FilePanelContent, type FilePanelPane } from "@/features/files/FilePanelContent";
import { terminalCwds } from "@/features/files/terminalCwds";
import { useRetainRemoteFilePanels } from "@/features/files/use-retain-remote-file-panels";
import { fileBrowsers } from "@/features/files/fileBrowsers";
import { forwardsStore, runningForwards, useForwards } from "@/features/forwards/forwardsStore";
import { activeConnections, forwardStatusText, runningRules } from "@/features/forwards/status";
import { ForwardsSidebar } from "@/features/forwards/ForwardsSidebar";
import { HomeView } from "@/features/home/HomeView";
import { rememberHostOpened, useRecordHostConnections } from "@/features/hosts/host-history";
import { useHosts } from "@/features/hosts/hostsStore";
import { updateSetting } from "@/features/updates/update-settings";
import { checkOnStartup, updatesStore } from "@/features/updates/updatesStore";
import { HostsPanel } from "@/features/hosts/HostsPanel";
import { useHostsController } from "@/features/hosts/useHostsController";
import { CommandPalette, type PaletteTab } from "@/features/palette/CommandPalette";
import { usePaletteActions, type PaletteAction } from "@/features/palette/palette-actions";
import { DiagnosticsPaletteActions } from "@/features/settings/diagnostics-section";
import { AppShell } from "@/features/shell/AppShell";
import { zoomTerminalFont } from "@/features/terminal/terminal-prefs";
import { useTerminalPrefs } from "@/features/terminal/terminal-prefs-context";
import { createBroadcast, type BroadcastScope } from "@/features/workspace/broadcast";
import { paneNeighbors } from "@/features/workspace/pane-layout";
import { currentPlatform, paneSwapShortcuts, shortcutLabel, type WorkspaceCommand } from "@/features/workspace/shortcuts";
import { TabPanels } from "@/features/workspace/TabPanels";
import { ConflictDialog } from "@/features/transfers/ConflictDialog";
import { transferSummary, transfersStore, useTransfers } from "@/features/transfers/transfersStore";
import { CloseTerminalsDialog } from "@/features/workspace/CloseTerminalsDialog";
import { TabStrip } from "@/features/workspace/TabStrip";
import { createTabActivity } from "@/features/workspace/tab-activity";
import {
  activePane,
  activeTab,
  canSplit,
  connectedHosts,
  countTerminalsClosing,
  newPane,
  reconnectingHosts,
  remoteTerminalPaneIds,
  tabPanes,
  tabTitle,
  tabsReducer,
  type CloseAction,
  type ConnectionStatus,
  type PaneKind,
  type ReconnectProgress,
  type SplitOrientation,
  type TabsState,
} from "@/features/workspace/tabs";
import { useWorkspaceShortcuts } from "@/features/workspace/use-workspace-shortcuts";
import { serializeWorkspaceLayout, workspaceLayoutSetting } from "@/features/workspace/workspace-layout";
import { workspaceSetting } from "@/features/workspace/workspace-prefs";
import type { Host } from "@/lib/ipc/hosts";
import { getSetting, setSetting } from "@/lib/storage";

const platform = currentPlatform();
const localTerminal: PaneKind = { kind: "local-terminal" };
/** Updates come from the installed app's updater: not in a plain browser, nor in the E2E build. */
const updatable = isTauri() && import.meta.env.VITE_E2E !== "1";

/**
 * Composes the main window. Each slot of `AppShell` is owned by a feature:
 * Host list (features/hosts), tabs and splits (features/workspace), File panel (features/files).
 */
export function App({ initialTabs }: { initialTabs: TabsState }) {
  const { t } = useTranslation();
  const { prefs: { titleSource } } = useTerminalPrefs();
  const [state, dispatch] = useReducer(tabsReducer, initialTabs);
  const { tabs, activeId } = state;
  const [pendingClose, setPendingClose] = useState<{ action: CloseAction; count: number } | null>(null);

  function requestClose(action: CloseAction) {
    if (pendingClose) return;
    const count = getSetting(workspaceSetting).confirmClose ? countTerminalsClosing(state, action) : 0;
    if (count > 0) setPendingClose({ action, count });
    else dispatch(action);
  }

  const focused = activeTab(state);
  const canSplitFocused = focused !== undefined && canSplit(focused);
  const focusedLayout = focused?.layout;
  const focusedPaneId = focused?.activePaneId;
  const paneMaximized = focused?.paneMaximized;
  const focusedPane = focused && activePane(focused);
  const hasFocusedTerminal = focusedPane?.kind === "local-terminal" || focusedPane?.kind === "remote-terminal";
  const [broadcast] = useState(createBroadcast);
  const [tabActivity] = useState(createTabActivity);
  useEffect(() => tabActivity.listen(), [tabActivity]);
  const broadcastMode = useStore(broadcast.store, (snapshot) => snapshot.mode);
  useLayoutEffect(() => {
    const tabIds = tabs.map((tab) => tab.id);
    tabActivity.updateWorkspace(activeId, tabIds);
    broadcast.updateWorkspace(
      focusedPaneId,
      tabIds,
      tabs.flatMap((tab) => tabPanes(tab).map((pane) => pane.id)),
    );
  }, [activeId, broadcast, focusedPaneId, tabActivity, tabs]);

  const toggleBroadcast = useCallback((scope: BroadcastScope) => {
    if (activeId !== null && hasFocusedTerminal) broadcast.toggle(scope, activeId);
    else if (broadcastMode?.scope === scope) broadcast.stop();
  }, [activeId, broadcast, broadcastMode, hasFocusedTerminal]);

  usePaletteActions(useMemo((): PaletteAction[] => [
    ...(hasFocusedTerminal && !(broadcastMode?.scope === "tab" && broadcastMode.tabId === activeId) ? [{
      id: "broadcast.tab",
      title: t("broadcast.toTab"),
      shortcut: shortcutLabel("broadcastTab", platform),
      run: () => toggleBroadcast("tab"),
    }] : []),
    ...(hasFocusedTerminal && broadcastMode?.scope !== "window" ? [{
      id: "broadcast.window",
      title: t("broadcast.toWindow"),
      shortcut: shortcutLabel("broadcastWindow", platform),
      run: () => toggleBroadcast("window"),
    }] : []),
    ...(broadcastMode ? [{
      id: "broadcast.off",
      title: t("broadcast.turnOff"),
      run: broadcast.stop,
    }] : []),
  ], [activeId, broadcast, broadcastMode, hasFocusedTerminal, t, toggleBroadcast]));
  const lastLayout = useRef<string | undefined>(undefined);
  useEffect(() => {
    const layout = serializeWorkspaceLayout(state);
    const snapshot = JSON.stringify(layout);
    if (lastLayout.current !== undefined && lastLayout.current !== snapshot) setSetting(workspaceLayoutSetting, layout);
    lastLayout.current = snapshot;
  }, [state]);

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
  const openSftp = useCallback((host: Host) => {
    rememberHostOpened(host.id);
    openTab({ kind: "sftp", host });
  }, [openTab]);
  const [sftpPickerOpen, setSftpPickerOpen] = useState(false);
  const pickSftpHost = useCallback(() => setSftpPickerOpen(true), []);
  const openHome = useCallback(() => openTab({ kind: "home" }), [openTab]);
  const openSettings = useCallback(() => openTab({ kind: "settings" }), [openTab]);
  const openForwards = useCallback((host: Host) => openTab({ kind: "port-forwards", host }), [openTab]);
  // Port forward states and transfers are pushed by the backend for the app's lifetime.
  useEffect(() => {
    void forwardsStore.getState().watch();
    void transfersStore.getState().watch();
  }, []);
  // A newer release is offered in the status bar; finding none (or failing) says nothing.
  useEffect(() => {
    if (updatable) return checkOnStartup(updatesStore, () => getSetting(updateSetting));
  }, []);
  const retitle = useCallback((paneId: string, title: string) => dispatch({ type: "retitle", paneId, title }), []);
  const setStatus = useCallback(
    (paneId: string, status: ConnectionStatus, reconnecting?: ReconnectProgress) => {
      fileBrowsers.connectionChanged(paneId, status);
      dispatch({ type: "status", paneId, status, reconnecting });
    },
    [],
  );

  /**
   * A new pane beside the focused one, using the same Host and working directory when known.
   * Non-Terminal panes that can split open a Local terminal beside them.
   */
  const split = (orientation: SplitOrientation) => {
    if (!canSplitFocused) return;
    const pane = activePane(focused);
    const kind: PaneKind = pane.kind === "remote-terminal"
      ? { kind: pane.kind, host: pane.host, initialCwd: terminalCwds.lastReported(pane.id) }
      : pane.kind === "local-terminal"
        ? { kind: pane.kind, cwd: pane.cwd }
        : localTerminal;
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
        return { id: tab.id, title: tabTitle(tab, t, ordinal, titleSource) };
      }),
    [tabs, t, titleSource],
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
        { id: "home.open", title: t("palette.actions.goHome"), keywords: [t("palette.keywords.hosts")], run: openHome },
        { id: "files.openSftp", title: t("sftp.open"), run: pickSftpHost },
        ...(canSplitFocused ? [
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
        ] : []),
        {
          id: "settings.open",
          title: t("palette.actions.openSettings"),
          keywords: [t("palette.keywords.preferences")],
          shortcut: shortcutLabel("settings", platform),
          run: openSettings,
        },
        ...(updatable
          ? [
              {
                id: "updates.check",
                title: t("updates.check"),
                keywords: [t("updates.keywords")],
                run: () => void updatesStore.getState().check("manual"),
              },
            ]
          : []),
      ],
      [t, openLocalTerminal, openHome, openSettings, pickSftpHost, canSplitFocused],
    ),
  );

  usePaletteActions(
    useMemo((): PaletteAction[] => {
      if (focusedLayout?.type !== "split" || !focusedPaneId) return [];
      const neighbors = paneNeighbors(focusedLayout, focusedPaneId);
      return [
        {
          id: "workspace.toggleMaximizePane",
          title: t(paneMaximized ? "tabs.restorePaneLayout" : "tabs.maximizePane"),
          shortcut: shortcutLabel("toggleMaximizePane", platform),
          run: () => dispatch({ type: "toggleMaximizePane" }),
        },
        ...paneSwapShortcuts
          .filter(({ direction }) => neighbors[direction])
          .map(({ name, direction }): PaletteAction => ({
            id: `workspace.${name}`,
            title: t(`tabs.${name}`),
            shortcut: shortcutLabel(name, platform),
            run: () => dispatch({ type: "swapPane", direction }),
          })),
      ];
    }, [focusedLayout, focusedPaneId, paneMaximized, t]),
  );

  useWorkspaceShortcuts(platform, (command: WorkspaceCommand) => {
    if (pendingClose) return;
    const tab = activeTab(state);
    switch (command.type) {
      case "newTab":
        return openLocalTerminal();
      case "closePane":
        if (tab) requestClose({ type: "closePane", paneId: tab.activePaneId });
        return;
      case "split":
        return split(command.orientation);
      case "cycleTab":
        return dispatch({ type: "cycle", step: command.step });
      case "toggleMaximizePane":
      case "swapPane":
        return dispatch(command);
      case "cyclePane":
        return dispatch({ type: "cyclePane", step: command.step });
      case "moveTab":
        if (tab) dispatch({ type: "move", id: tab.id, to: tabs.indexOf(tab) + command.step });
        return;
      case "toggleBroadcast":
        return toggleBroadcast(command.scope);
      case "openPalette":
        return setPaletteOpen((open) => !open);
      case "openSettings":
        return openSettings();
      case "zoomTerminalFont":
        return zoomTerminalFont(command.step);
      case "goToTab": {
        const target = tabs.at(command.index);
        if (target) dispatch({ type: "activate", id: target.id });
        return;
      }
    }
  });

  const hosts = useHosts((s) => s.tree.hosts);
  const hostsController = useHostsController({ open: openRemoteTerminal, openSftp, openForwards });
  const forwardStates = useForwards((s) => s.states);
  const held = useConnections((s) => s.held);
  const connectingHeld = useConnections((s) => s.connecting);
  const running = useMemo(() => runningForwards({ states: forwardStates }), [forwardStates]);
  const connected = useMemo(() => activeConnections(connectedHosts(state), running, hosts, held), [state, running, hosts, held]);
  const forwards = runningRules(running, hosts).map(({ rule }) => forwardStatusText(rule, t));
  const reconnecting = reconnectingHosts(state);
  // "Connect only" Hosts can be disconnected from the palette.
  const heldHosts = useMemo(() => hosts.filter((host) => held.includes(host.id)), [hosts, held]);
  usePaletteActions(
    useMemo(
      (): PaletteAction[] =>
        heldHosts.map((host) => ({
          id: `connections.disconnect.${host.id}`,
          title: t("palette.actions.disconnectHost", { name: host.name }),
          run: () => void connectionsStore.getState().disconnect(host.id),
        })),
      [heldHosts, t],
    ),
  );
  const transferList = useTransfers((s) => s.transfers);
  const transferSpeeds = useTransfers((s) => s.speeds);
  const transfers = transferSummary(transferList, transferSpeeds);
  const connections = useMemo(() => hostConnections(connected, state, connectingHeld), [connected, state, connectingHeld]);
  useRecordHostConnections(connections);
  const filePanelPane: FilePanelPane | undefined =
    focusedPane?.kind === "remote-terminal"
      ? { id: focusedPane.id, host: focusedPane.host, status: focusedPane.status ?? "connecting" }
      : undefined;
  useRetainRemoteFilePanels(remoteTerminalPaneIds(state));

  return (
    <>
      <DiagnosticsPaletteActions />
      <AppShell
        sidebar={{
          hosts: <HostsPanel controller={hostsController} connections={connections} />,
          forwards: <ForwardsSidebar onOpenForwards={openForwards} />,
        }}
        nav={{
          activeKind: focusedPane?.kind ?? null,
          onHome: openHome,
          onSftp: pickSftpHost,
          onLocalTerminal: openLocalTerminal,
          onSettings: openSettings,
        }}
        tabs={
          <TabStrip
            activity={tabActivity}
            tabs={tabs}
            activeId={activeId}
            platform={platform}
            titleSource={titleSource}
            onActivate={(id) => dispatch({ type: "activate", id })}
            onTabAction={(action) => {
              switch (action.type) {
                case "close":
                case "closeOthers":
                case "closeRight":
                  requestClose(action);
                  break;
                default:
                  dispatch(action);
              }
            }}
            onMove={(id, to) => dispatch({ type: "move", id, to })}
            onNewLocalTerminal={openLocalTerminal}
            onSplit={split}
          />
        }
        workspace={
          <TabPanels
            activity={tabActivity}
            broadcast={broadcast}
            tabs={tabs}
            activeId={activeId}
            renderHome={(active) => (
              <HomeView
                active={active}
                controller={hostsController}
                connections={connections}
                onOpenLocalTerminal={openLocalTerminal}
              />
            )}
            onFocusPane={(paneId) => dispatch({ type: "focusPane", paneId })}
            onClosePane={(paneId) => requestClose({ type: "closePane", paneId })}
            onEditHost={(host) => hostsController.actions.edit(hosts.find((saved) => saved.id === host.id) ?? host)}
            onConnectRestoredPane={(paneId) => dispatch({ type: "connectRestoredPane", paneId })}
            onTitleChange={retitle}
            onLocalCwd={(paneId, cwd) => dispatch({ type: "localCwd", paneId, cwd })}
            onStatusChange={setStatus}
            onResizeSplit={(tabId, resize) => dispatch({ type: "resizeSplit", tabId, ...resize })}
          />
        }
        fullWorkspace={!focusedPane || focusedPane.kind === "sftp" || focusedPane.kind === "home"}
        filePanel={<FilePanelContent pane={filePanelPane} onOpenSftp={openSftp} />}
        status={{
          connected,
          reconnecting,
          forwards,
          transfers,
          activeRemote: focusedPane?.kind === "remote-terminal" ? focusedPane.host : null,
          broadcast: broadcastMode && {
            scope: broadcastMode.scope,
            tabTitle: broadcastMode.scope === "tab" && broadcastMode.tabId !== activeId
              ? paletteTabs.find((tab) => tab.id === broadcastMode.tabId)?.title
              : undefined,
            stop: broadcast.stop,
          },
        }}
      />
      {hostsController.dialogs}
      <ConflictDialog />
      {pendingClose && (
        <CloseTerminalsDialog
          count={pendingClose.count}
          onCancel={() => setPendingClose(null)}
          onConfirm={(skipConfirmation) => {
            if (skipConfirmation) {
              setSetting(workspaceSetting, { ...getSetting(workspaceSetting), confirmClose: false });
            }
            dispatch(pendingClose.action);
            setPendingClose(null);
          }}
        />
      )}
      <CommandDialog
        open={sftpPickerOpen}
        onOpenChange={setSftpPickerOpen}
        title={t("sftp.open")}
        description={t("sftp.chooseHost")}
        showCloseButton={false}
      >
        <CommandInput placeholder={t("sftp.chooseHost")} aria-label={t("sftp.chooseHost")} />
        <CommandList>
          <CommandEmpty>{t(hosts.length ? "hosts.noResultsTitle" : "sftp.noHosts")}</CommandEmpty>
          {hosts.map((host) => (
            <CommandItem
              key={host.id}
              value={host.id}
              keywords={[host.name, host.address, host.user]}
              onSelect={() => {
                setSftpPickerOpen(false);
                openSftp(host);
              }}
            >
              <Server aria-hidden />
              <span className="min-w-0">
                <span className="block truncate font-medium">{host.name}</span>
                <span className="text-muted-foreground block truncate text-xs">{host.user}@{host.address}</span>
              </span>
            </CommandItem>
          ))}
        </CommandList>
      </CommandDialog>
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
