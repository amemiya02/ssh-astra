import { ArrowDownUp, BookmarkPlus, Cable, Eye, EyeOff, Radio, Settings, Waypoints } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { agentAccessSetting, setAgentAccess } from "@/features/agent/agent-access";
import { quickConnectLabel } from "@/features/connect/quick-connect";
import { formatSize } from "@/features/files/fileList";
import type { BroadcastScope } from "@/features/workspace/broadcast";
import { privacyModeSetting, togglePrivacyMode, workspaceHostName } from "@/features/workspace/privacy-mode";
import type { ReconnectProgress } from "@/features/workspace/tabs";
import type { Host } from "@/lib/ipc/hosts";
import { useSetting } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { ThemeMenu } from "@/theme/ThemeMenu";
import { useResolvedShortcuts } from "@/features/workspace/shortcut-settings";
import { shortcutLabel } from "@/features/workspace/shortcuts";

/** What the status bar reports; every field is live state, never a placeholder. */
export interface StatusInfo {
  /** Hosts with a live Connection (a Terminal, "Connect only" or a running Port forward). */
  connected: Host[];
  /** Hosts whose Terminals are retrying a dropped Connection. */
  reconnecting: ({ host: Host } & ReconnectProgress)[];
  /** Running Port forwards, worded (`localhost:15432 → db:5432`). */
  forwards: string[];
  transfers: { count: number; bytesPerSecond: number };
  updateNotice?: ReactNode;
  /** The Host of the focused remote Terminal. */
  activeRemote: Host | null;
  saveTemporaryHost?(): void;
  broadcast?: { scope: BroadcastScope; tabTitle?: string; stop(): void } | null;
}

const emptyStatus: StatusInfo = {
  connected: [],
  reconnecting: [],
  forwards: [],
  transfers: { count: 0, bytesPerSecond: 0 },
  activeRemote: null,
};

/** The 24px bottom bar: Connections, Port forwards and transfers on the left; the focused Host, theme and Settings on the right. */
export function StatusBar({
  info = emptyStatus,
  onShowForwards,
  onOpenTransfers,
  onOpenSettings,
}: {
  info?: StatusInfo;
  /** Shows the sidebar's Port forwards view. */
  onShowForwards(): void;
  onOpenTransfers(): void;
  onOpenSettings(): void;
}) {
  const { t } = useTranslation();
  const settingsShortcut = shortcutLabel("settings", useResolvedShortcuts());
  const [{ enabled: agentEnabled }] = useSetting(agentAccessSetting);
  const [privacyMode] = useSetting(privacyModeSetting);
  const { connected, reconnecting, forwards, transfers, activeRemote, saveTemporaryHost, broadcast, updateNotice } = info;
  const transferStatus = transfers.bytesPerSecond > 0
    ? t("status.transfersSpeed", { count: transfers.count, speed: formatSize(Math.round(transfers.bytesPerSecond)) })
    : transfers.count > 0 ? t("status.transfers", { count: transfers.count }) : undefined;
  const activeRemoteLabel = activeRemote && (privacyMode ? workspaceHostName(activeRemote, t, true) : quickConnectLabel(activeRemote));
  const broadcastStatus = broadcast?.tabTitle
    ? t("broadcast.namedTabStatus", { title: broadcast.tabTitle })
    : t(broadcast?.scope === "tab" ? "broadcast.tabStatus" : "broadcast.windowStatus");
  return (
    <footer className="text-muted-foreground bg-background flex h-6 shrink-0 items-stretch border-t text-xs">
      {broadcast && (
        <Segment
          as="button"
          label={t("broadcast.turnOff")}
          description={broadcastStatus}
          title={t("broadcast.turnOff")}
          onClick={broadcast.stop}
        >
          <Radio className="text-warning size-3 shrink-0" aria-hidden />
          <span className="max-w-40 truncate">{broadcastStatus}</span>
        </Segment>
      )}
      {agentEnabled && (
        <Segment
          as="button"
          label={t("agentAccess.turnOff")}
          title={t("agentAccess.turnOff")}
          onClick={() => void setAgentAccess(false)}
        >
          <Cable className="text-primary size-3 shrink-0" aria-hidden />
          <span className="max-w-40 truncate">{t("agentAccess.enabled")}</span>
        </Segment>
      )}
      <div role="status" className="flex min-w-0 flex-1 items-stretch overflow-hidden">
        {connected.length === 0 && reconnecting.length === 0 && <Segment>{t("status.noConnections")}</Segment>}
        {connected.map((host) => {
          const name = workspaceHostName(host, t, privacyMode);
          return (
            <Segment key={host.id} title={t("status.connectedTo", { hosts: name })}>
              <span aria-hidden className="bg-success size-1.5 shrink-0 rounded-full" />
              <span className="truncate">{name}</span>
            </Segment>
          );
        })}
        {reconnecting.map(({ host, attempt, attempts }) => (
          <Segment key={host.id}>
            <span aria-hidden className="bg-warning size-1.5 shrink-0 animate-pulse rounded-full" />
            <span className="truncate tabular-nums">{t("status.reconnecting", {
              host: workspaceHostName(host, t, privacyMode), attempt, attempts,
            })}</span>
          </Segment>
        ))}
        {forwards.length > 0 && (
          <Segment
            as="button"
            title={privacyMode ? undefined : t("status.forwards", { list: forwards.join(", ") })}
            onClick={onShowForwards}
          >
            <Waypoints className="size-3" aria-hidden />
            <span className="tabular-nums">{t("status.forwardsCount", { count: forwards.length })}</span>
          </Segment>
        )}
      </div>
      {updateNotice}
      <Segment
        as="button"
        title={t("transfers.open")}
        label={t("transfers.open")}
        description={transferStatus}
        onClick={onOpenTransfers}
      >
        <ArrowDownUp className="size-3 shrink-0" aria-hidden />
        <span className="truncate tabular-nums">{transferStatus ?? t("transfers.title")}</span>
      </Segment>
      <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
        {activeRemoteLabel && (
          <span className={cn("mr-1 truncate", !privacyMode && "font-mono")} title={activeRemoteLabel}>
            {activeRemoteLabel}
          </span>
        )}
        {saveTemporaryHost && (
          <IconButton
            label={t("quickConnect.saveAsHost")}
            className="size-5"
            tooltipSide="top"
            onClick={saveTemporaryHost}
          >
            <BookmarkPlus className="size-3.5" aria-hidden />
          </IconButton>
        )}
        <IconButton
          label={t("privacyMode.label")}
          aria-pressed={privacyMode}
          tooltipSide="top"
          className="size-5 aria-pressed:bg-selected aria-pressed:text-primary"
          onClick={togglePrivacyMode}
        >
          {privacyMode ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
        </IconButton>
        <ThemeMenu />
        <IconButton label={t("settings.open")} shortcut={settingsShortcut} className="size-5" onClick={onOpenSettings}>
          <Settings className="size-3.5" />
        </IconButton>
      </div>
    </footer>
  );
}

/** One status bar segment, closed off by a thin divider; a `button` segment is clickable. */
function Segment({
  as = "div",
  title,
  label,
  description,
  onClick,
  children,
}: {
  as?: "div" | "button";
  title?: string;
  label?: string;
  description?: string;
  onClick?(): void;
  children: ReactNode;
}) {
  const className = "flex min-w-0 items-center gap-1.5 border-r px-2.5";
  if (as === "button") {
    return (
      <button
        type="button"
        title={title}
        aria-label={label}
        aria-description={description}
        className={cn(className, "hover:bg-accent hover:text-foreground active:bg-accent/70 focus-visible:ring-ring/50 outline-none focus-visible:ring-2 focus-visible:ring-inset")}
        onClick={onClick}
      >
        {children}
      </button>
    );
  }
  return (
    <div title={title} className={className}>
      {children}
    </div>
  );
}
