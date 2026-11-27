import { ArrowDown, ArrowRight, ArrowUp, Check, FolderOpen, Pause, Play, RotateCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { Button } from "@/components/ui/button";
import { formatSize } from "@/features/files/fileList";
import { showToast } from "@/features/toasts/toastStore";
import { privacyModeSetting, workspaceHostName } from "@/features/workspace/privacy-mode";
import { revealDownload, type Transfer } from "@/lib/ipc/transfers";
import { useSetting } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { formatDuration, isFinished, timeLeft, transfersStore } from "./transfersStore";

export function TransferRow({ transfer, speed, canReveal = false }: {
  transfer: Transfer;
  speed: number | undefined;
  canReveal?: boolean;
}) {
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
        {canReveal && state.type === "done" && transfer.direction === "download" && (
          <IconButton
            label={t("transfers.reveal")}
            className="size-6"
            onClick={() => {
              void revealDownload(transfer.id).catch(() =>
                showToast((translate) => translate("transfers.revealFailed", { name: transfer.name }), "error"));
            }}
          >
            <FolderOpen />
          </IconButton>
        )}
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
