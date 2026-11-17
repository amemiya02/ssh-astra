import { Server, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface HostsSidebarProps {
  /** Header actions (e.g. "New Host"), right of the title. */
  actions?: ReactNode;
  /** The Host list. Omit to show the first-run empty state. */
  children?: ReactNode;
  onOpenLocalTerminal(): void;
}

/** The left column: title, Host list slot, and the Local terminal shortcut pinned at the bottom. */
export function HostsSidebar({ actions, children, onOpenLocalTerminal }: HostsSidebarProps) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full min-h-0 flex-col py-2.5 pr-1 pl-2.5">
      <div className="flex h-7 items-center gap-1 px-1">
        <h2 className="flex-1 truncate font-semibold">{t("hosts.title")}</h2>
        {actions}
      </div>
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">{children ?? <HostListEmpty />}</div>
      <Button variant="outline" size="sm" className="mt-2 w-full" onClick={onOpenLocalTerminal}>
        <SquareTerminal aria-hidden />
        {t("tabs.localTerminal")}
      </Button>
    </div>
  );
}

function HostListEmpty() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-2 px-1 py-4">
      <Server className="text-muted-foreground size-5" aria-hidden />
      <p className="font-medium">{t("hosts.emptyTitle")}</p>
      <p className="text-muted-foreground text-pretty">{t("hosts.emptyBody")}</p>
    </div>
  );
}
