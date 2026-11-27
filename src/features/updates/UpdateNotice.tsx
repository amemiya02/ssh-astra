import { isTauri } from "@tauri-apps/api/core";
import type { TFunction } from "i18next";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import type { InterruptionCounts } from "@/features/workspace/interruption-counts";
import { countLiveConnections } from "@/lib/ipc/windows";
import { UpdateDialog } from "./UpdateDialog";
import { updatesStore, useUpdates, type UpdateStatus } from "./updatesStore";

/** How long the answer to a manual check stays in the status bar. */
const answerMs = 6000;

/** The words for an update status; `null` when the status bar shows nothing. */
function noticeText(status: UpdateStatus, t: TFunction): string | null {
  switch (status.type) {
    case "idle":
      return null;
    case "checking":
      return t("updates.checking");
    case "upToDate":
      return t("updates.upToDate");
    case "checkFailed":
      return t("updates.checkFailed", { reason: status.reason });
    case "available":
      return t("updates.available", { version: status.version });
    case "downloading":
      return status.total
        ? t("updates.downloadingPercent", {
            percent: Math.min(100, Math.floor((status.downloaded / status.total) * 100)),
          })
        : t("updates.downloading");
    case "installFailed":
      return t("updates.installFailed", { reason: status.reason });
    case "restarting":
      return t("updates.restarting");
  }
}

/**
 * The status bar entry for reviewing an update, tracking its progress, or seeing the answer
 * to a manual check (which clears itself).
 */
export function UpdateNotice({ interruptions }: { interruptions: InterruptionCounts }) {
  const { t } = useTranslation();
  const status = useUpdates((s) => s.status);
  const { install, dismiss } = updatesStore.getState();
  const [connectionsAtReview, setConnectionsAtReview] = useState<number>();
  const [counting, setCounting] = useState(false);
  const reviews = useRef(0);

  function reviewChanged(open: boolean) {
    const review = ++reviews.current;
    setConnectionsAtReview(undefined);
    const readCount = open && isTauri();
    setCounting(readCount);
    if (readCount) {
      void countLiveConnections().then((count) => {
        if (reviews.current === review) setConnectionsAtReview(count);
      }).catch((error: unknown) => {
        console.warn("Could not count live Connections before updating", error);
      }).finally(() => {
        if (reviews.current === review) setCounting(false);
      });
    }
  }

  useEffect(() => {
    if (status.type !== "upToDate" && status.type !== "checkFailed") return;
    const timer = window.setTimeout(dismiss, answerMs);
    return () => window.clearTimeout(timer);
  }, [status, dismiss]);

  const text = noticeText(status, t);
  if (text === null) return null;
  const canInstall = status.type === "available" || status.type === "installFailed";
  const canDismiss = status.type !== "downloading" && status.type !== "restarting" && status.type !== "checking";

  return (
    <span role="status" className="flex min-w-0 shrink-0 items-center gap-1 border-r px-2.5 tabular-nums">
      {canInstall ? (
        <Dialog onOpenChange={reviewChanged}>
          <DialogTrigger asChild>
            <Button variant="ghost" size="xs" className="text-foreground h-5 min-w-0 font-medium" title={text}>
              <span className="max-w-48 truncate">{text}</span>
            </Button>
          </DialogTrigger>
          <UpdateDialog
            version={status.version}
            notes={status.notes}
            failure={status.type === "installFailed" ? status.reason : undefined}
            interruptions={{ ...interruptions, connections: connectionsAtReview ?? interruptions.connections }}
            countingConnections={counting}
            onInstall={() => void install()}
          />
        </Dialog>
      ) : (
        <span className="max-w-48 truncate" title={text}>{text}</span>
      )}
      {canDismiss && (
        <IconButton label={t("updates.dismiss")} className="size-5" onClick={dismiss}>
          <X className="size-3.5" />
        </IconButton>
      )}
    </span>
  );
}
