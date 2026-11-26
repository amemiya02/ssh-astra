import { isTauri } from "@tauri-apps/api/core";
import { ArrowDownUp, Server } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { connectionsStore, useConnections } from "@/features/connect/connectionsStore";
import { CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { FilePanelContent, type FilePanelPane } from "@/features/files/FilePanelContent";
import { useRetainRemoteFilePanels } from "@/features/files/use-retain-remote-file-panels";
import { fileBrowsers } from "@/features/files/fileBrowsers";
import { formatSize } from "@/features/files/fileList";
import { forwardsStore, runningForwards, useForwards } from "@/features/forwards/forwardsStore";
import { activeConnections, forwardStatusText, runningRules } from "@/features/forwards/status";
import { useHosts } from "@/features/hosts/hostsStore";
import { updateSetting } from "@/features/updates/update-settings";
import { UpdateNotice } from "@/features/updates/UpdateNotice";
import { checkOnStartup, updatesStore } from "@/features/updates/updatesStore";
import { HostsPanel } from "@/features/hosts/HostsPanel";
import { CommandPalette, type PaletteTab } from "@/features/palette/CommandPalette";
import { usePaletteActions, type PaletteAction } from "@/features/palette/palette-actions";
import { rememberHostOpened } from "@/features/palette/recent-hosts";
import { AppShell } from "@/features/shell/AppShell";
import { currentPlatform, shortcutLabel, type WorkspaceCommand } from "@/features/workspace/shortcuts";
import { TabPanels } from "@/features/workspace/TabPanels";
import { ConflictDialog } from "@/features/transfers/ConflictDialog";
import { transferSummary, transfersStore, useTransfers } from "@/features/transfers/transfersStore";
import { TabStrip } from "@/features/workspace/TabStrip";
import {
  activePane,
  activeTab,
  connectedHosts,
  emptyTabs,
  newPane,
  reconnectingHosts,
  remoteTerminalPaneIds,
  tabTitle,
  tabsReducer,
  type ConnectionStatus,
  type PaneKind,
  type ReconnectProgress,
  type SplitOrientation,
  type TabsState,
} from "@/features/workspace/tabs";
import { useWorkspaceShortcuts } from "@/features/workspace/use-workspace-shortcuts";
import type { Host } from "@/lib/ipc/hosts";
import { getSetting } from "@/lib/storage";

const platform = currentPlatform();
const localTerminal: PaneKind = { kind: "local-terminal" };
/** Updates come from the installed app's updater: not in a plain browser, nor in the E2E build. */
const updatable = isTauri() && import.meta.env.VITE_E2E !== "1";

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
  const openSftp = useCallback((host: Host) => {
    rememberHostOpened(host.id);
    openTab({ kind: "sftp", host });
  }, [openTab]);
  const [sftpPickerOpen, setSftpPickerOpen] = useState(false);
  const pickSftpHost = useCallback(() => setSftpPickerOpen(true), []);
  const openSettings = useCallback(() => openTab({ kind: "settings" }), [openTab]);
  const openForwards = useCallback((host: Host) => openTab({ kind: "port-forwards", host }), [openTab]);
  // Port forward states and transfers are pushed by the backend for the app's lifetime.
  useEffect(() => {
    void forwardsStore.getState().watch();
    void transfersStore.getState().watch();
  }, []);
  // A newer release is offered in the status bar; finding none (or failing) says nothing.
  useEffect(() => {
    if (updatable) void checkOnStartup(updatesStore, getSetting(updateSetting));
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
   * A new pane beside the focused one, running the same kind of Terminal (the same Host's shares its
   * Connection); beside Settings, a Local terminal.
   */
  const split = (orientation: SplitOrientation) => {
    const tab = activeTab(state);
    if (!tab || activePane(tab).kind === "sftp") return;
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
        { id: "files.openSftp", title: t("sftp.open"), run: pickSftpHost },
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
      [t, openLocalTerminal, openSettings, pickSftpHost],
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
      case "openSettings":
        return openSettings();
      case "goToTab": {
        const target = tabs.at(command.index);
        if (target) dispatch({ type: "activate", id: target.id });
        return;
      }
    }
  });

  const hosts = useHosts((s) => s.tree.hosts);
  const forwardStates = useForwards((s) => s.states);
  const held = useConnections((s) => s.held);
  const running = runningForwards({ states: forwardStates });
  const connected = activeConnections(connectedHosts(state), running, hosts, held);
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
  const focused = activeTab(state);
  const focusedPane = focused && activePane(focused);
  const filePanelPane: FilePanelPane | undefined =
    focusedPane?.kind === "remote-terminal"
      ? { id: focusedPane.id, host: focusedPane.host, status: focusedPane.status ?? "connecting" }
      : undefined;
  useRetainRemoteFilePanels(remoteTerminalPaneIds(state));

  return (
    <>
      <AppShell
        sidebar={
          <HostsPanel
            onOpen={openRemoteTerminal}
            onOpenSftp={openSftp}
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
            onOpenSftp={pickSftpHost}
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
        fullWorkspace={focusedPane?.kind === "sftp"}
        filePanel={<FilePanelContent pane={filePanelPane} onOpenSftp={openSftp} />}
        onOpenSettings={openSettings}
        status={
          <span role="status" className="flex min-w-0 items-center gap-3.5">
            <span className="truncate">
              {connected.length === 0
                ? t("status.noConnections")
                : t("status.connectedTo", { hosts: connected.map((host) => host.name).join(", ") })}
            </span>
            {reconnecting.length > 0 && (
              <span className="truncate">
                {reconnecting
                  .map(({ host, attempt, attempts }) =>
                    t("status.reconnecting", { host: host.name, attempt, attempts }),
                  )
                  .join(", ")}
              </span>
            )}
            {forwards.length > 0 && (
              <span className="truncate">{t("status.forwards", { list: forwards.join(", ") })}</span>
            )}
            {transfers.count > 0 && (
              <span className="flex shrink-0 items-center gap-1 tabular-nums">
                <ArrowDownUp className="size-3" aria-hidden />
                {transfers.bytesPerSecond > 0
                  ? t("status.transfersSpeed", {
                      count: transfers.count,
                      speed: formatSize(Math.round(transfers.bytesPerSecond)),
                    })
                  : t("status.transfers", { count: transfers.count })}
              </span>
            )}
            <UpdateNotice />
          </span>
        }
      />
      <ConflictDialog />
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
