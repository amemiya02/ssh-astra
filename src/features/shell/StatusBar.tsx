import { ArrowDownUp, Settings, Waypoints } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { formatSize } from "@/features/files/fileList";
import { UpdateNotice } from "@/features/updates/UpdateNotice";
import type { ReconnectProgress } from "@/features/workspace/tabs";
import type { Host } from "@/lib/ipc/hosts";
import { cn } from "@/lib/utils";
import { ThemeMenu } from "@/theme/ThemeMenu";
import { currentPlatform, shortcutLabel } from "@/features/workspace/shortcuts";

const settingsShortcut = shortcutLabel("settings", currentPlatform());

/** What the status bar reports; every field is live state, never a placeholder. */
export interface StatusInfo {
  /** Hosts with a live Connection (a Terminal, "Connect only" or a running Port forward). */
  connected: Host[];
  /** Hosts whose Terminals are retrying a dropped Connection. */
  reconnecting: ({ host: Host } & ReconnectProgress)[];
  /** Running Port forwards, worded (`localhost:15432 → db:5432`). */
  forwards: string[];
  transfers: { count: number; bytesPerSecond: number };
  /** The Host of the focused remote Terminal. */
  activeRemote: Host | null;
}

const emptyStatus: StatusInfo = {
  connected: [],
  reconnecting: [],
  forwards: [],
  transfers: { count: 0, bytesPerSecond: 0 },
  activeRemote: null,
};

const address = (host: Host) => `${host.user}@${host.address}${host.port === 22 ? "" : `:${host.port}`}`;

/** The 24px bottom bar: Connections, Port forwards and transfers on the left; the focused Host, theme and Settings on the right. */
export function StatusBar({
  info = emptyStatus,
  onShowForwards,
  onOpenSettings,
}: {
  info?: StatusInfo;
  /** Shows the sidebar's Port forwards view. */
  onShowForwards(): void;
  onOpenSettings(): void;
}) {
  const { t } = useTranslation();
  const { connected, reconnecting, forwards, transfers, activeRemote } = info;
  return (
    <footer className="text-muted-foreground bg-background flex h-6 shrink-0 items-stretch border-t text-xs">
      <div role="status" className="flex min-w-0 flex-1 items-stretch overflow-hidden">
        {connected.length === 0 && reconnecting.length === 0 && <Segment>{t("status.noConnections")}</Segment>}
        {connected.map((host) => (
          <Segment key={host.id} title={t("status.connectedTo", { hosts: host.name })}>
            <span aria-hidden className="bg-success size-1.5 shrink-0 rounded-full" />
            <span className="truncate">{host.name}</span>
          </Segment>
        ))}
        {reconnecting.map(({ host, attempt, attempts }) => (
          <Segment key={host.id}>
            <span aria-hidden className="bg-warning size-1.5 shrink-0 animate-pulse rounded-full" />
            <span className="truncate tabular-nums">{t("status.reconnecting", { host: host.name, attempt, attempts })}</span>
          </Segment>
        ))}
        {forwards.length > 0 && (
          <Segment
            as="button"
            title={t("status.forwards", { list: forwards.join(", ") })}
            onClick={onShowForwards}
          >
            <Waypoints className="size-3" aria-hidden />
            <span className="tabular-nums">{t("status.forwardsCount", { count: forwards.length })}</span>
          </Segment>
        )}
        {transfers.count > 0 && (
          <Segment>
            <ArrowDownUp className="size-3" aria-hidden />
            <span className="tabular-nums">
              {transfers.bytesPerSecond > 0
                ? t("status.transfersSpeed", {
                    count: transfers.count,
                    speed: formatSize(Math.round(transfers.bytesPerSecond)),
                  })
                : t("status.transfers", { count: transfers.count })}
            </span>
          </Segment>
        )}
        <UpdateNotice />
      </div>
      <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
        {activeRemote && (
          <span className="mr-1 truncate font-mono" title={address(activeRemote)}>
            {address(activeRemote)}
          </span>
        )}
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
  onClick,
  children,
}: {
  as?: "div" | "button";
  title?: string;
  onClick?(): void;
  children: ReactNode;
}) {
  const className = "flex min-w-0 items-center gap-1.5 border-r px-2.5";
  if (as === "button") {
    return (
      <button
        type="button"
        title={title}
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
