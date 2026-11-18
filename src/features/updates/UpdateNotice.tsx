import { X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { Button } from "@/components/ui/button";
import { updatesStore, useUpdates, type UpdateStatus } from "./updatesStore";

/** How long the answer to a manual check stays in the status bar. */
const answerMs = 6000;

/** The words for an update status; `null` when the status bar shows nothing. */
function noticeText(status: UpdateStatus, t: ReturnType<typeof useTranslation>["t"]): string | null {
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
 * The update notice in the status bar: a newer version with "Update and restart", the download
 * in progress, or the short answer to a manual check (which clears itself).
 */
export function UpdateNotice() {
  const { t } = useTranslation();
  const status = useUpdates((s) => s.status);
  const { install, dismiss } = updatesStore.getState();

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
    <span className="flex min-w-0 shrink-0 items-center gap-1 tabular-nums">
      <span className="truncate" title={text}>
        {text}
      </span>
      {canInstall && (
        <Button
          variant="ghost"
          size="xs"
          className="text-foreground h-5 font-medium"
          onClick={() => void install()}
        >
          {status.type === "installFailed" ? t("updates.retry") : t("updates.install")}
        </Button>
      )}
      {canDismiss && (
        <IconButton label={t("updates.dismiss")} className="size-5" onClick={dismiss}>
          <X className="size-3.5" />
        </IconButton>
      )}
    </span>
  );
}
