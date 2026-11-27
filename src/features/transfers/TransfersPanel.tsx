import { ArrowDown, ArrowRight, ArrowUp, Check, ChevronDown, ChevronRight, Pause, Play, RotateCw, Trash2, X } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Button } from "@/components/ui/button";
import { formatSize } from "@/features/files/fileList";
import { privacyModeSetting, workspaceHostName } from "@/features/workspace/privacy-mode";
import type { FilePanelDock } from "@/features/shell/shell-layout";
import type { Transfer } from "@/lib/ipc/transfers";
import { useSetting } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { transferSetting } from "./transfer-settings";
import {
  activeTransfers,
  doneTransfers,
  formatDuration,
  isFinished,
  timeLeft,
  transfersStore,
  useTransfers,
} from "./transfersStore";

/**
 * The transfer list inside the File panel (DESIGN.md "Transfer row"): Active and Done, each
 * row with progress, speed, time left and the actions available for its current state. Collapsible to its header; hidden
 * while there are no transfers.
 */
export function TransfersPanel({ dock, visible }: { dock: FilePanelDock; visible: boolean }) {
  const { t } = useTranslation();
  const transfers = useTransfers((s) => s.transfers);
  const speeds = useTransfers((s) => s.speeds);
  const [settings, setSettings] = useSetting(transferSetting);
  const [view, setView] = useState<"active" | "done">("active");
  const collapsed = settings.panelCollapsed;
  useLayoutEffect(() => {
    if (visible && !collapsed) return transfersStore.getState().trackVisiblePanel();
  }, [collapsed, visible]);
  if (transfers.length === 0) return null;

  const active = activeTransfers(transfers);
  const done = doneTransfers(transfers);
  const shown = view === "active" ? active : done;
  const toggle = () => setSettings({ ...settings, panelCollapsed: !collapsed });

  return (
    <section
      aria-label={t("transfers.title")}
      className={cn(
        "flex min-h-0 shrink-0 flex-col",
        dock === "bottom" ? "border-l" : "max-h-[45%] border-t",
        dock === "bottom" && !collapsed && "w-[45%] max-w-120 min-w-56",
      )}
    >
      <header className="flex h-10 shrink-0 items-center gap-1 pr-2 pl-1.5">
        <IconButton label={collapsed ? t("transfers.expand") : t("transfers.collapse")} onClick={toggle} aria-expanded={!collapsed}>
          {collapsed ? <ChevronRight /> : <ChevronDown />}
        </IconButton>
        <h3 className="flex-1 truncate font-semibold">{t("transfers.title")}</h3>
        {!collapsed && view === "done" && done.length > 0 && (
          <IconButton
            label={t("transfers.clearDone")}
            onClick={() => void transfersStore.getState().dismiss(done.map((d) => d.id))}
          >
            <Trash2 />
          </IconButton>
        )}
        {!collapsed && (
          <SegmentedControl
            label={t("transfers.title")}
            value={view}
            options={[
              { value: "active", label: t("transfers.active", { count: active.length }) },
              { value: "done", label: t("transfers.done", { count: done.length }) },
            ]}
            onChange={(value) => setView(value as "active" | "done")}
          />
        )}
      </header>
      {!collapsed && (
        <ul className="min-h-0 flex-1 overflow-auto px-3 pb-2">
          {shown.length === 0 ? (
            <li className="text-muted-foreground p-4 text-center text-xs">
              {view === "active" ? t("transfers.noneActive") : t("transfers.noneDone")}
            </li>
          ) : (
            shown.map((transfer) => (
              <TransferRow key={transfer.id} transfer={transfer} speed={speeds[transfer.id]} />
            ))
          )}
        </ul>
      )}
    </section>
  );
}

function TransferRow({ transfer, speed }: { transfer: Transfer; speed: number | undefined }) {
  const { t } = useTranslation();
  const [privacyMode] = useSetting(privacyModeSetting);
  const { state } = transfer;
  const failed = state.type === "failed";
  const percent =
    transfer.bytesTotal > 0
      ? Math.floor((transfer.bytesDone / transfer.bytesTotal) * 100)
      : state.type === "done"
        ? 100
        : 0;
  const Direction = { upload: ArrowUp, download: ArrowDown, copy: ArrowRight }[transfer.direction];
  const sourceName = transfer.sourceHost && workspaceHostName(transfer.sourceHost, t, privacyMode);
  const targetName = transfer.targetHost && workspaceHostName(transfer.targetHost, t, privacyMode);
  const source = sourceName ? `${sourceName} · ${transfer.source}` : transfer.source;
  const target = targetName ? `${targetName} · ${transfer.target}` : transfer.target;
  const route = `${source} → ${target}`;
  const left = timeLeft(transfer, speed);

  let detail: string;
  switch (state.type) {
    case "queued":
      detail = t("transfers.state.queued");
      break;
    case "paused":
      detail = t("transfers.state.paused");
      break;
    case "conflict":
      detail = t("transfers.state.conflict");
      break;
    case "failed":
      detail = state.message;
      break;
    case "cancelled":
      detail = t("transfers.state.cancelled");
      break;
    default: {
      const parts = [
        t("transfers.progress", { done: formatSize(transfer.bytesDone), total: formatSize(transfer.bytesTotal) }),
      ];
      if (transfer.filesTotal > 1)
        parts.push(t("transfers.files", { done: transfer.filesDone, total: transfer.filesTotal }));
      if (state.type === "running" && speed !== undefined) parts.push(`${formatSize(Math.round(speed))}/s`);
      if (state.type === "running" && left !== null) parts.push(t("transfers.timeLeft", { time: formatDuration(left) }));
      detail = parts.join(" · ");
    }
  }

  return (
    <li className="group py-2">
      <div className="flex items-center gap-2">
        {state.type === "done" ? (
          <Check className="text-success size-4 shrink-0" aria-label={t("transfers.state.done")} />
        ) : (
          <Direction
            className={cn("size-4 shrink-0", failed ? "text-destructive" : "text-primary")}
            aria-label={t(`transfers.direction.${transfer.direction}`)}
          />
        )}
        <span className="min-w-0 flex-1 truncate font-medium" title={route}>
          {transfer.name}
        </span>
        {state.type !== "done" && !failed && (
          <span className="text-muted-foreground text-xs tabular-nums">{percent}%</span>
        )}
        {(state.type === "queued" || state.type === "running") && (
          <IconButton
            label={t("transfers.pause")}
            className="size-6"
            onClick={() => void transfersStore.getState().pause(transfer.id)}
          >
            <Pause />
          </IconButton>
        )}
        {state.type === "paused" && (
          <IconButton
            label={t("transfers.resume")}
            className="size-6"
            onClick={() => void transfersStore.getState().resume(transfer.id)}
          >
            <Play />
          </IconButton>
        )}
        {failed || state.type === "cancelled" ? (
          <>
            <Button
              variant="ghost"
              size="xs"
              className="h-6"
              onClick={() => void transfersStore.getState().retry(transfer.id)}
            >
              <RotateCw aria-hidden />
              {t("transfers.retry")}
            </Button>
            <IconButton
              label={t("transfers.dismiss")}
              className="size-6"
              onClick={() => void transfersStore.getState().dismiss([transfer.id])}
            >
              <X />
            </IconButton>
          </>
        ) : (
          !isFinished(transfer) && (
            <IconButton
              label={t("transfers.cancel")}
              className="size-6"
              onClick={() => void transfersStore.getState().cancel(transfer.id)}
            >
              <X />
            </IconButton>
          )
        )}
      </div>
      {sourceName && targetName && (
        <p className="text-muted-foreground mt-1 truncate text-xs" title={route}>
          {sourceName} → {targetName}
        </p>
      )}
      {state.type !== "done" && (
        <div
          role="progressbar"
          aria-label={transfer.name}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="bg-muted mt-1.5 h-1 overflow-hidden rounded-full"
        >
          <div
            className={cn("h-full rounded-full transition-[width]", failed ? "bg-destructive" : "bg-primary")}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      <p className={cn("mt-1 truncate text-xs tabular-nums", failed ? "text-destructive" : "text-muted-foreground")}>
        {detail}
      </p>
      {transfer.unprotected && (
        <p className="text-warning mt-1 text-xs">
          <span className="font-medium">{t("transfers.unprotected.label")}</span>{" "}
          {t("transfers.unprotected.detail")}
        </p>
      )}
    </li>
  );
}
