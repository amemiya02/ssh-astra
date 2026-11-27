import { ArrowRightLeft } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { HostMonogram } from "@/features/hosts/HostMonogram";
import { useHosts } from "@/features/hosts/hostsStore";
import { SidebarHeader } from "@/features/shell/SidebarHeader";
import type { Host } from "@/lib/ipc/hosts";
import { cn } from "@/lib/utils";
import { runningForwards, useForwards } from "./forwardsStore";
import { hostsWithForwards } from "./forwardsSummary";

/** The sidebar's Port forwards view: Hosts that have rules, each with its running count; click opens its tab. */
export function ForwardsSidebar({ onOpenForwards }: { onOpenForwards(host: Host): void }) {
  const { t } = useTranslation();
  const hosts = useHosts((s) => s.tree.hosts);
  const states = useForwards((s) => s.states);
  const rows = useMemo(() => hostsWithForwards(hosts, runningForwards({ states })), [hosts, states]);

  return (
    <section aria-label={t("forwards.title")} className="flex h-full min-h-0 flex-col pr-1 pl-2.5">
      <SidebarHeader title={t("forwards.title")} />
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-2.5">
        {rows.length === 0 ? (
          <div className="flex flex-col items-start gap-2 px-1 py-4">
            <ArrowRightLeft className="text-muted-foreground size-5" aria-hidden />
            <p className="font-medium">{t("forwards.sidebar.emptyTitle")}</p>
            <p className="text-muted-foreground text-pretty">{t("forwards.sidebar.emptyBody")}</p>
          </div>
        ) : (
          <ul aria-label={t("forwards.title")} className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
            {rows.map(({ host, running, total }) => (
              <li key={host.id}>
                <button
                  type="button"
                  className="hover:bg-accent active:bg-accent/70 focus-visible:ring-ring/50 flex h-7.5 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left outline-none focus-visible:ring-[3px]"
                  onClick={() => onOpenForwards(host)}
                >
                  <HostMonogram host={host} />
                  <span className="min-w-0 flex-1 truncate font-medium">{host.name}</span>
                  <span
                    className={cn("shrink-0 text-xs tabular-nums", running > 0 ? "text-success" : "text-muted-foreground")}
                    title={t("forwards.sidebar.runningOf", { running, total })}
                  >
                    {running}/{total}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
