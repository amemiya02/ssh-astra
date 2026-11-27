import { Server } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SidebarHeader } from "@/features/shell/SidebarHeader";

interface HostsSidebarProps {
  /** Header actions (e.g. "New Host"), right of the title. */
  actions?: ReactNode;
  /** The Host list. Omit to show the first-run empty state. */
  children?: ReactNode;
  /** Shown under the first-run empty state (e.g. "Import ~/.ssh/config"). */
  emptyAction?: ReactNode;
}

/** The sidebar's Hosts view: title and actions over the Host list slot. */
export function HostsSidebar({ actions, children, emptyAction }: HostsSidebarProps) {
  const { t } = useTranslation();
  return (
    <section aria-label={t("hosts.title")} className="flex h-full min-h-0 flex-col pr-1 pl-2.5">
      <SidebarHeader title={t("hosts.title")}>{actions}</SidebarHeader>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2.5">{children ?? <HostListEmpty action={emptyAction} />}</div>
    </section>
  );
}

function HostListEmpty({ action }: { action?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-2 px-1 py-4">
      <Server className="text-muted-foreground size-5" aria-hidden />
      <p className="font-medium">{t("hosts.emptyTitle")}</p>
      <p className="text-muted-foreground text-pretty">{t("hosts.emptyBody")}</p>
      {action}
    </div>
  );
}
