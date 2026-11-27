import { X } from "lucide-react";
import { Tabs } from "radix-ui";
import { useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { FilePanelDockContext, useFilePanelDock } from "@/features/shell/file-panel-dock";
import type { TerminalId } from "@/lib/ipc/terminal";
import { ResourcePanel } from "./ResourcePanel";

const tabStyle = "h-full border-b-2 border-transparent px-2 pt-0.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[state=active]:border-primary data-[state=active]:text-foreground";

const pageVisible = () => document.visibilityState === "visible";
function subscribePageVisibility(changed: () => void) {
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
}

/** The two views available in a remote Terminal's dock. */
export function TerminalDock({ terminalId, generation, resources, paused, onSelect, children }: {
  generation?: number;
  terminalId: TerminalId | null;
  resources: boolean;
  paused: boolean;
  onSelect(resources: boolean): void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const dock = useFilePanelDock();
  const { collapse, collapsed } = dock;
  const visible = useSyncExternalStore(subscribePageVisibility, pageVisible);
  return (
    <Tabs.Root activationMode="manual" value={resources ? "resources" : "files"} onValueChange={(view) => onSelect(view === "resources")}
      className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center justify-between gap-1 border-b px-2">
        <Tabs.List aria-label={t("resources.dock")} className="flex h-full items-center gap-1">
          <Tabs.Trigger value="files" className={tabStyle}>{t("files.title")}</Tabs.Trigger>
          <Tabs.Trigger value="resources" className={tabStyle}>{t("resources.title")}</Tabs.Trigger>
        </Tabs.List>
        <IconButton label={t(resources ? "resources.hide" : "files.hide")} onClick={collapse}><X /></IconButton>
      </header>
      <Tabs.Content forceMount value="files" className="min-h-0 flex-1 flex-col outline-none data-[state=active]:flex" hidden={resources}>
        <FilePanelDockContext value={{ ...dock, collapsed: collapsed || resources }}>{children}</FilePanelDockContext>
      </Tabs.Content>
      <Tabs.Content value="resources" className="min-h-0 flex-1 overflow-auto outline-none" hidden={!resources}>
        {resources && !collapsed && !paused && visible && (
          terminalId === null
            ? <p className="text-muted-foreground p-4 text-sm" role="status">{t("resources.connect")}</p>
            : <ResourcePanel key={`${terminalId}:${generation ?? 0}`} terminalId={terminalId} />
        )}
      </Tabs.Content>
    </Tabs.Root>
  );
}
