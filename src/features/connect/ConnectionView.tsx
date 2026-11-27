import { Check, Circle, CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { CommandError, ConnectProgress } from "@/lib/ipc/connect";
import type { Host, HostId } from "@/lib/ipc/hosts";
import { ConnectErrorPanel } from "./ConnectErrorPanel";

type Stage = ConnectProgress["stage"];
export type ObservedProgress = ConnectProgress & { receivedAt: number };

const connectionStages: Stage[] = ["reach", "hostKey", "authenticate"];
const terminalStages: Stage[] = [...connectionStages, "shell"];

const statusStyle = {
  pending: { Icon: Circle, color: "text-muted-foreground" },
  running: { Icon: LoaderCircle, color: "text-warning motion-safe:animate-spin" },
  succeeded: { Icon: Check, color: "text-success" },
  failed: { Icon: CircleAlert, color: "text-destructive" },
};

interface Hop {
  name: string;
  jumpHost: boolean;
  steps: Map<Stage, ObservedProgress>;
}

export function ConnectionSteps({ host, steps }: { host: Pick<Host, "id" | "name">; steps: ObservedProgress[] }) {
  const { t, i18n } = useTranslation();
  const running = steps.find((step) => step.status === "running");
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(timer);
  }, [running]);

  const hops = new Map<HostId, Hop>();
  for (const step of steps) {
    let hop = hops.get(step.hostId);
    if (!hop) {
      hop = { name: step.hostName, jumpHost: step.jumpHost, steps: new Map() };
      hops.set(step.hostId, hop);
    }
    hop.steps.set(step.stage, step);
  }
  if (!hops.has(host.id)) hops.set(host.id, { name: host.name, jumpHost: false, steps: new Map() });
  const duration = new Intl.NumberFormat(i18n.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  return (
    <div className="space-y-3">
      {[...hops].map(([id, hop]) => {
        const stages = hop.steps.has("reused")
          ? hop.jumpHost ? ["reused"] as const : ["reused", "shell"] as const
          : hop.jumpHost ? connectionStages : terminalStages;
        const shown = hop.steps.has("waiting") ? ["waiting", ...stages] as const : stages;
        const name = hop.jumpHost ? t("connect.progress.jumpHost", { name: hop.name }) : hop.name;
        return (
          <div key={id} className="border-border bg-surface overflow-hidden rounded-lg border">
            <h3 className="border-border bg-muted/40 border-b px-3 py-2 text-xs font-semibold break-words">{name}</h3>
            <ol aria-label={name} className="divide-border divide-y">
              {shown.map((stage) => {
                const step = hop.steps.get(stage);
                const status = step?.status ?? "pending";
                const { Icon, color } = statusStyle[status];
                const elapsed = step && (step.elapsedMs + (status === "running" ? Math.max(0, now - step.receivedAt) : 0));
                return (
                  <li key={stage} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-xs">
                    <Icon className={`size-3.5 shrink-0 ${color}`} aria-hidden />
                    <span className="min-w-24 flex-1 font-medium">
                      {t(`connect.progress.stage.${stage}`)}
                      {step?.method && <span className="text-muted-foreground font-normal"> · {t(`connect.progress.method.${step.method}`)}</span>}
                    </span>
                    <span className={status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                      {t(`connect.progress.status.${status}`)}
                    </span>
                    <span className="text-muted-foreground min-w-11 text-right tabular-nums">
                      {elapsed === undefined ? "—" : t("connect.progress.seconds", { duration: duration.format(elapsed / 1000) })}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })}
      <span className="sr-only" role="status">
        {running && t("connect.progress.announcement", {
          host: running.hostName,
          stage: t(`connect.progress.stage.${running.stage}`),
        })}
      </span>
    </div>
  );
}

interface Props {
  host: Host;
  steps: ObservedProgress[];
  error: CommandError | null;
  onRetry(): void;
  onEditHost(): void;
  onClose(): void;
}

export function ConnectionView({ host, steps, error, onRetry, onEditHost, onClose }: Props) {
  const { t } = useTranslation();
  return (
    <div className="bg-surface absolute inset-0 overflow-auto px-4 py-5 sm:px-6">
      <div className="mx-auto max-w-lg space-y-3">
        <h2 className="text-base font-semibold">{t(error ? "connect.progress.failed" : "connect.progress.connecting")}</h2>
        <ConnectionSteps host={host} steps={steps} />
        {error && (
          <>
            <div className="[&>*]:m-0">
              <ConnectErrorPanel error={error} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={onRetry}>{t("connect.progress.retry")}</Button>
              <Button size="sm" variant="outline" onClick={onEditHost}>{t("hosts.edit")}</Button>
              <Button size="sm" variant="ghost" onClick={onClose}>{t("connect.progress.close")}</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
