import { isTauri } from "@tauri-apps/api/core";
import { Server } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { connectionsStore, useConnections } from "@/features/connect/connectionsStore";
import { hostConnections } from "@/features/connect/hostConnection";
import { AgentReviewDialog } from "@/features/agent/AgentReviewDialog";
import { SshLinkConfirmation } from "@/features/connect/SshLinkConfirmation";
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
import { OpenSshStartupOffer } from "@/features/hosts/openSshSync";
import { hostsStore, useHosts } from "@/features/hosts/hostsStore";
import { updateSetting } from "@/features/updates/update-settings";
import { UpdateNotice } from "@/features/updates/UpdateNotice";
import { checkOnStartup, updatesStore } from "@/features/updates/updatesStore";
import { HostsPanel } from "@/features/hosts/HostsPanel";
import { useHostsController } from "@/features/hosts/useHostsController";
import { CommandPalette, type PaletteTab } from "@/features/palette/CommandPalette";
import { usePaletteActions, type PaletteAction } from "@/features/palette/palette-actions";
import { DiagnosticsPaletteActions } from "@/features/settings/diagnostics-section";
import { AppShell } from "@/features/shell/AppShell";
import { TerminalDock } from "@/features/resources/TerminalDock";
import type { ResourceHistories } from "@/features/resources/resource-history";
import { SnippetsSidebar } from "@/features/snippets/SnippetsSidebar";
import { zoomTerminalFont } from "@/features/terminal/terminal-prefs";
import { useTerminalPrefs } from "@/features/terminal/terminal-prefs-context";
import { terminalOutputKinds, terminalOutputs } from "@/features/terminal/terminal-outputs";
import { createBroadcast, type BroadcastScope } from "@/features/workspace/broadcast";
import { interruptionCounts } from "@/features/workspace/interruption-counts";
import { MacosMenu } from "@/features/workspace/MacosMenu";
import { paneNeighbors } from "@/features/workspace/pane-layout";
import { privacyModeSetting, togglePrivacyMode } from "@/features/workspace/privacy-mode";
import { QuitConfirmation } from "@/features/workspace/QuitConfirmation";
import { useResolvedShortcuts } from "@/features/workspace/shortcut-settings";
import { currentPlatform, paneSwapShortcuts, shortcutLabel, type WorkspaceCommand } from "@/features/workspace/shortcuts";
import { TabPanels } from "@/features/workspace/TabPanels";
import { ConflictDialog } from "@/features/transfers/ConflictDialog";
import { showToast } from "@/features/toasts/toastStore";
import { transferSummary, transfersStore, useTransfers } from "@/features/transfers/transfersStore";
import { CloseTerminalsDialog } from "@/features/workspace/CloseTerminalsDialog";
import { TabStrip } from "@/features/workspace/TabStrip";
import { createTabActivity } from "@/features/workspace/tab-activity";
import { moveTabToNewWindow } from "@/features/workspace/tab-window-move";
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
  type Tab,
  type TabsState,
} from "@/features/workspace/tabs";
import { ShortcutCaptureContext, useWorkspaceShortcuts } from "@/features/workspace/use-workspace-shortcuts";
import { serializeWorkspaceLayout, workspaceLayoutSetting } from "@/features/workspace/workspace-layout";
import { workspaceSetting } from "@/features/workspace/workspace-prefs";
import { createTemporaryHost, forgetTemporaryHost, isTemporaryHost, type Host, type HostId, type QuickConnectTarget } from "@/lib/ipc/hosts";
import type { SshLinkTarget } from "@/lib/ipc/ssh-links";
import { newWindow } from "@/lib/ipc/windows";
import { getSetting, setSetting, useSetting } from "@/lib/storage";

const platform = currentPlatform();
const localTerminal: PaneKind = { kind: "local-terminal" };
/** Updates come from the installed app's updater: not in a plain browser, nor in the E2E build. */
const updatable = isTauri() && import.meta.env.VITE_E2E !== "1";

/**
 * Composes one Window. Each slot of `AppShell` is owned by a feature:
 * Host list (features/hosts), tabs and splits (features/workspace), File panel (features/files).
 */
export function App({ initialTabs, startupTabsAcrossWindows, incomingMove }: {
  initialTabs: TabsState;
  startupTabsAcrossWindows?: readonly TabsState[] | null;
  incomingMove?: Promise<void>;
}) {
  const { t } = useTranslation();
  const shortcuts = useResolvedShortcuts(platform);
  const [privacyMode] = useSetting(privacyModeSetting);
  const { prefs: { titleSource } } = useTerminalPrefs();
  const [state, dispatch] = useReducer(tabsReducer, initialTabs);
  const { tabs, activeId } = state;
  const [resourceHistories] = useState<ResourceHistories>(() => new Map());
  const [moving, setMoving] = useState(incomingMove !== undefined);
  const moveInProgress = useRef(incomingMove !== undefined);
  useEffect(() => {
    void incomingMove?.then(() => {
      moveInProgress.current = false;
      setMoving(false);
    });
  }, [incomingMove]);

  const moveToWindow = async (tab: Tab) => {
    if (moveInProgress.current) return;
    moveInProgress.current = true;
    flushSync(() => setMoving(true));
    try {
      await moveTabToNewWindow(tab);
      dispatch({ type: "removeMovedTab", id: tab.id });
    } catch {
      showToast((t) => t("tabs.moveToNewWindowFailed"), "error");
    } finally {
      moveInProgress.current = false;
      setMoving(false);
    }
  };
  const [pendingClose, setPendingClose] = useState<{ action: CloseAction; count: number } | null>(null);

  function requestClose(action: CloseAction) {
    if (pendingClose || moveInProgress.current) return;
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
  const focusedOutput = useStore(terminalOutputs.store, (snapshot) => focusedPaneId ? snapshot.get(focusedPaneId) : undefined);
  const hasFocusedTerminal = focusedPane?.kind === "local-terminal" || focusedPane?.kind === "remote-terminal";
  const [broadcast] = useState(createBroadcast);
  const [tabActivity] = useState(createTabActivity);
  useEffect(() => tabActivity.listen(), [tabActivity]);
  const broadcastMode = useStore(broadcast.store, (snapshot) => snapshot.mode);
  useLayoutEffect(() => {
    const tabIds = tabs.map((tab) => tab.id);
    tabActivity.updateWorkspace(activeId, tabIds);
    broadcast.updateWorkspace(
      moving ? undefined : focusedPaneId,
      tabIds,
      moving ? [] : tabs.flatMap((tab) => tabPanes(tab).map((pane) => pane.id)),
    );
  }, [activeId, broadcast, focusedPaneId, moving, tabActivity, tabs]);

  const toggleBroadcast = useCallback((scope: BroadcastScope) => {
    if (activeId !== null && hasFocusedTerminal) broadcast.toggle(scope, activeId);
    else if (broadcastMode?.scope === scope) broadcast.stop();
  }, [activeId, broadcast, broadcastMode, hasFocusedTerminal]);

  usePaletteActions(useMemo((): PaletteAction[] => [
    ...(hasFocusedTerminal && !(broadcastMode?.scope === "tab" && broadcastMode.tabId === activeId) ? [{
      id: "broadcast.tab",
      title: t("broadcast.toTab"),
      shortcut: shortcutLabel("broadcastTab", shortcuts),
      run: () => toggleBroadcast("tab"),
    }] : []),
    ...(hasFocusedTerminal && broadcastMode?.scope !== "window" ? [{
      id: "broadcast.window",
      title: t("broadcast.toWindow"),
      shortcut: shortcutLabel("broadcastWindow", shortcuts),
      run: () => toggleBroadcast("window"),
    }] : []),
    ...(broadcastMode ? [{
      id: "broadcast.off",
      title: t("broadcast.turnOff"),
      run: broadcast.stop,
    }] : []),
  ], [activeId, broadcast, broadcastMode, hasFocusedTerminal, shortcuts, t, toggleBroadcast]));
  const lastLayout = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (moving) return;
    const layout = serializeWorkspaceLayout(state);
    const snapshot = JSON.stringify(layout);
    if ((incomingMove || lastLayout.current !== undefined) && lastLayout.current !== snapshot) {
      setSetting(workspaceLayoutSetting, layout);
    }
    lastLayout.current = snapshot;
  }, [incomingMove, moving, state]);

  const openTab = useCallback(
    (kind: PaneKind, startupOrder?: number) => {
      const pane = newPane(kind);
      if (startupOrder !== undefined) pane.restoreConnection = { order: startupOrder };
      dispatch({ type: "open", tabId: crypto.randomUUID(), pane });
    },
    [],
  );
  const openLocalTerminal = useCallback(() => openTab(localTerminal), [openTab]);
  const openRemoteTerminal = useCallback(
    (host: Host, startupOrder?: number, expectedTarget?: SshLinkTarget) => {
      if (!isTemporaryHost(host)) rememberHostOpened(host.id);
      openTab({ kind: "remote-terminal", host, expectedTarget }, startupOrder);
    },
    [openTab],
  );
  const startupHostsOpened = useRef(false);
  useEffect(() => {
    if (startupHostsOpened.current || startupTabsAcrossWindows === null) return;
    startupHostsOpened.current = true;
    // main loads the Host list and restores the workspace before mounting App.
    const { status, tree } = hostsStore.getState();
    if (status !== "ready") return;
    const opened = new Set<HostId>();
    let order = 0;
    for (const workspace of startupTabsAcrossWindows ?? [initialTabs]) {
      for (const pane of workspace.tabs.flatMap(tabPanes)) {
        if ("host" in pane) opened.add(pane.host.id);
      }
    }
    for (const pane of initialTabs.tabs.flatMap(tabPanes)) {
      if (typeof pane.restoreConnection === "object") order = Math.max(order, pane.restoreConnection.order + 1);
    }
    for (const host of tree.hosts) {
      if (!host.openOnStartup || opened.has(host.id) || isTemporaryHost(host)) continue;
      openRemoteTerminal(host, order++);
      opened.add(host.id);
    }
  }, [initialTabs, openRemoteTerminal, startupTabsAcrossWindows]);
  const [quickConnectFailed, setQuickConnectFailed] = useState(false);
  const openQuickConnect = useCallback(async (target: QuickConnectTarget) => {
    setQuickConnectFailed(false);
    try {
      openRemoteTerminal(await createTemporaryHost(target));
    } catch {
      setQuickConnectFailed(true);
    }
  }, [openRemoteTerminal]);
  const openSftp = useCallback((host: Host) => {
    if (!isTemporaryHost(host)) rememberHostOpened(host.id);
    openTab({ kind: "sftp", host });
  }, [openTab]);
  const [sftpPickerOpen, setSftpPickerOpen] = useState(false);
  const pickSftpHost = useCallback(() => setSftpPickerOpen(true), []);
  const openHome = useCallback(() => openTab({ kind: "home" }), [openTab]);
  const openSettings = useCallback(() => openTab({ kind: "settings" }), [openTab]);
  const openTransfers = useCallback(() => openTab({ kind: "transfers" }), [openTab]);
  const openForwards = useCallback((host: Host) => openTab({ kind: "port-forwards", host }), [openTab]);
  // Port forward states and transfers are pushed by the backend for the app's lifetime.
  useEffect(() => {
    void forwardsStore.getState().watch();
    void transfersStore.getState().watch();
  }, []);
  // A newer release is offered in the status bar; finding none (or failing) says nothing.
  useEffect(() => {
    if (updatable && startupTabsAcrossWindows !== null) return checkOnStartup(updatesStore, () => getSetting(updateSetting));
  }, [startupTabsAcrossWindows]);
  const retitle = useCallback((paneId: string, title: string) => dispatch({ type: "retitle", paneId, title }), []);
  const setStatus = useCallback(
    (paneId: string, status: ConnectionStatus, reconnecting?: ReconnectProgress) => {
      fileBrowsers.connectionChanged(paneId, status);
      dispatch({ type: "status", paneId, status, reconnecting });
    },
    [],
  );

  /**
   * A new pane beside the selected one, using the same Host and working directory when known.
   * Non-Terminal panes that can split open a Local terminal beside them.
   */
  const split = (orientation: SplitOrientation, paneId?: string) => {
    if (!focused || !canSplit(focused, paneId)) return;
    const pane = paneId === undefined ? activePane(focused) : tabPanes(focused).find((pane) => pane.id === paneId);
    if (!pane) return;
    const kind: PaneKind = pane.kind === "remote-terminal"
      ? { kind: pane.kind, host: pane.host, initialCwd: terminalCwds.lastReported(pane.id) }
      : pane.kind === "local-terminal"
        ? { kind: pane.kind, cwd: pane.cwd, shellId: pane.shellId }
        : localTerminal;
    dispatch({ type: "split", orientation, pane: newPane(kind), paneId: pane.id });
  };

  // The palette's split actions run the latest `split`, without re-registering on every change.
  const splitRef = useRef(split);
  useEffect(() => {
    splitRef.current = split;
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openWindow = useCallback(() => {
    if (!isTauri()) return;
    void newWindow().catch((error: unknown) => {
      console.warn("Could not open a Window", error);
      showToast((t) => t("window.openFailed"), "error");
    });
  }, []);
  const activateTab = useCallback((id: string) => dispatch({ type: "activate", id }), []);
  const paletteTabs = useMemo(
    (): PaletteTab[] =>
      tabs.map((tab, index) => {
        const kind = activePane(tab).kind;
        const ordinal = tabs.slice(0, index + 1).filter((other) => activePane(other).kind === kind).length;
        return { id: tab.id, title: tabTitle(tab, t, ordinal, titleSource, privacyMode) };
      }),
    [tabs, t, titleSource, privacyMode],
  );
  usePaletteActions(
    useMemo(
      (): PaletteAction[] => [
        ...(isTauri() ? [{
          id: "window.new",
          title: t("window.new"),
          shortcut: shortcutLabel("newWindow", shortcuts),
          run: openWindow,
        }] : []),
        {
          id: "terminal.newLocal",
          title: t("tabs.newLocalTerminal"),
          shortcut: shortcutLabel("newTab", shortcuts),
          run: openLocalTerminal,
        },
        ...(focusedOutput && focusedPaneId ? terminalOutputKinds.map((kind) => ({
          id: `terminal.${kind}`,
          title: t(`terminal.${kind}.${focusedOutput[kind] ? "stop" : "start"}`),
          run: () => void terminalOutputs.toggle(focusedPaneId, kind),
        })) : []),
        { id: "home.open", title: t("palette.actions.goHome"), keywords: [t("palette.keywords.hosts")], run: openHome },
        { id: "files.openSftp", title: t("sftp.open"), run: pickSftpHost },
        { id: "transfers.open", title: t("transfers.open"), run: openTransfers },
        {
          id: "privacyMode.toggle",
          title: t(privacyMode ? "privacyMode.turnOff" : "privacyMode.turnOn"),
          run: togglePrivacyMode,
        },
        ...(canSplitFocused ? [
          {
            id: "workspace.splitRight",
            title: t("tabs.splitRight"),
            shortcut: shortcutLabel("splitRight", shortcuts),
            run: () => splitRef.current("horizontal"),
          },
          {
            id: "workspace.splitDown",
            title: t("tabs.splitDown"),
            shortcut: shortcutLabel("splitDown", shortcuts),
            run: () => splitRef.current("vertical"),
          },
        ] : []),
        {
          id: "settings.open",
          title: t("palette.actions.openSettings"),
          keywords: [t("palette.keywords.preferences")],
          shortcut: shortcutLabel("settings", shortcuts),
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
      [t, openLocalTerminal, openWindow, openHome, openSettings, openTransfers, pickSftpHost, canSplitFocused, privacyMode, shortcuts, focusedOutput, focusedPaneId],
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
          shortcut: shortcutLabel("toggleMaximizePane", shortcuts),
          run: () => dispatch({ type: "toggleMaximizePane" }),
        },
        ...paneSwapShortcuts
          .filter(({ direction }) => neighbors[direction])
          .map(({ name, direction }): PaletteAction => ({
            id: `workspace.${name}`,
            title: t(`tabs.${name}`),
            shortcut: shortcutLabel(name, shortcuts),
            run: () => dispatch({ type: "swapPane", direction }),
          })),
      ];
    }, [focusedLayout, focusedPaneId, paneMaximized, shortcuts, t]),
  );

  function runWorkspaceCommand(command: WorkspaceCommand) {
    if (pendingClose || moveInProgress.current) return;
    const tab = activeTab(state);
    switch (command.type) {
      case "newTab":
        return openLocalTerminal();
      case "newWindow":
        return openWindow();
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
  }
  const shortcutCapture = useWorkspaceShortcuts(platform, runWorkspaceCommand);

  const hosts = useHosts((s) => s.tree.hosts);
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
  const interruptions = useMemo(() => interruptionCounts(connected, transferList, running), [connected, transferList, running]);
  const transferSpeeds = useTransfers((s) => s.speeds);
  const transfers = transferSummary(transferList, transferSpeeds);
  const connections = useMemo(() => hostConnections(connected, state, connectingHeld), [connected, state, connectingHeld]);
  const temporaryHosts = useMemo(() => {
    const ids = new Set<HostId>();
    for (const pane of tabs.flatMap(tabPanes)) {
      if ("host" in pane && isTemporaryHost(pane.host)) ids.add(pane.host.id);
    }
    return ids;
  }, [tabs]);
  const previousTemporaryHosts = useRef(new Set<HostId>());
  useEffect(() => {
    for (const id of previousTemporaryHosts.current) {
      if (!temporaryHosts.has(id)) void forgetTemporaryHost(id);
    }
    previousTemporaryHosts.current = new Set(temporaryHosts);
  }, [temporaryHosts]);
  const hostsController = useHostsController({ open: openRemoteTerminal, openSftp, openForwards }, (host) => {
    // Saving already moved the backend entry out of the temporary registry.
    previousTemporaryHosts.current.delete(host.id);
    dispatch({ type: "saveTemporaryHost", host });
  });
  const focusedTemporaryHost = focusedPane && "host" in focusedPane && isTemporaryHost(focusedPane.host)
    ? focusedPane.host
    : undefined;
  const savedConnections = useMemo(() => new Map([...connections].filter(([id]) => !temporaryHosts.has(id))), [connections, temporaryHosts]);
  useRecordHostConnections(savedConnections);
  const filePanelPane: FilePanelPane | undefined =
    focusedPane?.kind === "remote-terminal"
      ? { id: focusedPane.id, host: focusedPane.host, status: focusedPane.status ?? "connecting" }
      : undefined;
  const filePanelPeers = useMemo(() => tabs.flatMap(tabPanes).flatMap((pane) =>
    pane.kind === "remote-terminal" && pane.status === "connected"
      ? [{ id: pane.id, host: pane.host, status: pane.status }]
      : []), [tabs]);
  useRetainRemoteFilePanels(remoteTerminalPaneIds(state));
  useEffect(() => {
    if (!resourceHistories.size) return;
    const connectedGenerations = new Map(tabs.flatMap(tabPanes).flatMap((pane) =>
      pane.kind === "remote-terminal" && pane.status === "connected" && pane.terminalId !== undefined
        ? [[pane.terminalId, pane.connectionGeneration ?? 0] as const] : []));
    for (const [id, history] of resourceHistories) {
      if (connectedGenerations.get(id) !== history.generation) resourceHistories.delete(id);
    }
  }, [resourceHistories, tabs]);

  return (
    <ShortcutCaptureContext.Provider value={shortcutCapture}>
      <DiagnosticsPaletteActions />
      {platform === "mac" && isTauri() && (
        <MacosMenu shortcuts={shortcuts} canClosePane={Boolean(focused) && !pendingClose} runWorkspaceCommand={runWorkspaceCommand} />
      )}
      <AppShell
        movingTab={moving}
        sidebar={{
          hosts: <HostsPanel controller={hostsController} connections={connections} />,
          forwards: <ForwardsSidebar onOpenForwards={openForwards} />,
          snippets: <SnippetsSidebar
            broadcast={broadcast}
            paneId={hasFocusedTerminal ? focusedPaneId : undefined}
            hostId={focusedPane?.kind === "remote-terminal" ? focusedPane.host.id : undefined}
            hosts={hosts}
          />,
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
            hosts={hosts}
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
            onNewLocalShell={(shellId) => openTab({ kind: "local-terminal", shellId })}
            onSplit={split}
            onSaveTemporaryHost={hostsController.openTemporaryHostEditor}
            onMoveToWindow={isTauri() ? (tab) => { void moveToWindow(tab); } : undefined}
          />
        }
        workspace={
          <TabPanels
            moving={moving}
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
                onQuickConnect={openQuickConnect}
              />
            )}
            onFocusPane={(paneId) => dispatch({ type: "focusPane", paneId })}
            onSplitPane={(paneId, orientation) => split(orientation, paneId)}
            onClosePane={(paneId) => requestClose({ type: "closePane", paneId })}
            onEditHost={(host) => hostsController.actions.edit(hosts.find((saved) => saved.id === host.id) ?? host)}
            onConnectRestoredPane={(paneId) => dispatch({ type: "connectRestoredPane", paneId })}
            onTitleChange={retitle}
            onRemoteTerminal={(paneId, id, savedHost) => dispatch({ type: "attachRemoteTerminal", paneId, id, savedHost })}
            onLocalCwd={(paneId, cwd) => dispatch({ type: "localCwd", paneId, cwd })}
            onStatusChange={setStatus}
            onResizeSplit={(tabId, resize) => dispatch({ type: "resizeSplit", tabId, ...resize })}
          />
        }
        fullWorkspace={!focusedPane || focusedPane.kind === "sftp" || focusedPane.kind === "home" || focusedPane.kind === "transfers"}
        filePanel={focusedPane?.kind === "remote-terminal" ? (
          <TerminalDock
            terminalId={focusedPane.status === "connected" ? focusedPane.terminalId ?? null : null}
            generation={focusedPane.connectionGeneration}
            histories={resourceHistories}
            resources={focusedPane.showResources === true}
            paused={moving}
            onSelect={(show) => dispatch({ type: "showResources", paneId: focusedPane.id, show })}
          >
            <FilePanelContent pane={filePanelPane} peers={filePanelPeers} onOpenSftp={openSftp} tabbed />
          </TerminalDock>
        ) : <FilePanelContent />}
        onOpenTransfers={openTransfers}
        status={{
          connected,
          reconnecting,
          forwards,
          transfers,
          updateNotice: <UpdateNotice interruptions={interruptions} />,
          activeRemote: focusedPane?.kind === "remote-terminal" ? focusedPane.host : null,
          activeTerminal: !moving && focusedPane?.kind === "remote-terminal"
            && focusedPane.status === "connected" && focusedPane.terminalId !== undefined
            ? { id: focusedPane.terminalId, generation: focusedPane.connectionGeneration ?? 0 }
            : undefined,
          saveTemporaryHost: focusedTemporaryHost && (() => hostsController.openTemporaryHostEditor(focusedTemporaryHost)),
          broadcast: broadcastMode && {
            scope: broadcastMode.scope,
            tabTitle: broadcastMode.scope === "tab" && broadcastMode.tabId !== activeId
              ? paletteTabs.find((tab) => tab.id === broadcastMode.tabId)?.title
              : undefined,
            stop: broadcast.stop,
          },
        }}
      />
      {quickConnectFailed && (
        <p role="alert" className="bg-popover text-destructive fixed inset-x-4 bottom-8 z-10 mx-auto w-fit rounded-md border px-3 py-2 text-sm">
          {t("quickConnect.failed")}
        </p>
      )}
      {startupTabsAcrossWindows !== null && <OpenSshStartupOffer />}
      {hostsController.dialogs}
      <ConflictDialog />
      <SshLinkConfirmation onConnect={(target, host) => {
        if (host) openRemoteTerminal(host, undefined, target);
        else void openQuickConnect(target);
      }} />
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
                {!privacyMode && (
                  <span className="text-muted-foreground block truncate text-xs">{host.user}@{host.address}</span>
                )}
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
        onQuickConnect={openQuickConnect}
        onActivateTab={activateTab}
      />
      <AgentReviewDialog />
      <QuitConfirmation interruptions={interruptions} />
    </ShortcutCaptureContext.Provider>
  );
}
