import { LoaderCircle, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { Host } from "@/lib/ipc/hosts";
import type { ConnectionState } from "@/lib/ipc/terminal";
import { ConnectionSteps, type ObservedProgress } from "./ConnectionView";

interface Props {
  host: Pick<Host, "id" | "name">;
  /** A dropped Connection: being retried, or given up on. */
  state: Exclude<ConnectionState, { state: "connected" }>;
  steps: ObservedProgress[];
  onReconnect(): void;
}

/**
 * Covers a remote Terminal whose Connection dropped. While automatic tries run it shows
 * their progress; after the last failure it keeps those steps and offers manual Reconnect.
 */
export function DisconnectedOverlay({ host, state, steps, onReconnect }: Props) {
  const { t } = useTranslation();
  return (
    <div className="bg-overlay absolute inset-0 z-10 flex items-center justify-center p-4">
      <div className="bg-popover text-popover-foreground shadow-overlay grid max-h-full w-full max-w-lg gap-3 overflow-auto rounded-xl border px-5 py-4">
        <div className="grid justify-items-center gap-2 text-center" role="status">
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
            <p className="text-muted-foreground text-xs break-all">{state.reason || t("connect.lost.failed")}</p>
          )}
        </div>
        {state.state === "disconnected" && (
          <Button size="sm" className="justify-self-center" onClick={onReconnect}>
            {t("connect.lost.reconnect")}
          </Button>
        )}
        <ConnectionSteps host={host} steps={steps} />
        <p className="text-muted-foreground text-center text-xs text-pretty">{t("connect.lost.newShell")}</p>
      </div>
    </div>
  );
}
