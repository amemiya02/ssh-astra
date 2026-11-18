import { LoaderCircle, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { ConnectionState } from "@/lib/ipc/terminal";

interface Props {
  /** A dropped Connection: being retried, or given up on. */
  state: Exclude<ConnectionState, { state: "connected" }>;
  onReconnect(): void;
}

/**
 * Covers a remote Terminal whose Connection dropped. While automatic tries run it shows
 * their progress; once they have all failed it keeps only the manual Reconnect button.
 */
export function DisconnectedOverlay({ state, onReconnect }: Props) {
  const { t } = useTranslation();
  return (
    <div className="bg-overlay absolute inset-0 z-10 flex items-center justify-center p-4">
      <div
        role="status"
        aria-live="polite"
        className="bg-popover text-popover-foreground shadow-overlay flex max-w-sm flex-col items-center gap-2 rounded-xl border px-5 py-4 text-center"
      >
        <p className="flex items-center gap-2 font-semibold">
          <Unplug className="text-destructive size-4 shrink-0" aria-hidden />
          {t("connect.lost.title")}
        </p>
        {state.state === "reconnecting" ? (
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs tabular-nums">
            <LoaderCircle className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
            {t("connect.lost.reconnecting", { attempt: state.attempt, attempts: state.attempts })}
          </p>
        ) : (
          <>
            <p className="text-muted-foreground text-xs break-all">{state.reason || t("connect.lost.failed")}</p>
            <Button size="sm" className="mt-1" onClick={onReconnect}>
              {t("connect.lost.reconnect")}
            </Button>
          </>
        )}
        <p className="text-muted-foreground text-xs text-pretty">{t("connect.lost.newShell")}</p>
      </div>
    </div>
  );
}
