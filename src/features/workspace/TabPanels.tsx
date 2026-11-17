import { SquareTerminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { LocalTerminalView } from "@/features/terminal/LocalTerminalView";
import { tabId, tabPanelId, type Tab } from "./tabs";

interface TabPanelsProps {
  tabs: Tab[];
  activeId: string | null;
  onNewLocalTerminal(): void;
  /** A program in the tab set its title (empty string clears it). */
  onTitleChange(id: string, title: string): void;
}

/**
 * Every open tab stays mounted (a Terminal keeps its shell and scrollback while hidden);
 * only the active one is shown.
 */
export function TabPanels({ tabs, activeId, onNewLocalTerminal, onTitleChange }: TabPanelsProps) {
  const { t } = useTranslation();

  if (tabs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <SquareTerminal className="text-muted-foreground size-6" aria-hidden />
        <div className="space-y-1">
          <p className="text-foreground font-medium">{t("workspace.emptyTitle")}</p>
          <p className="text-muted-foreground max-w-72 text-balance">{t("workspace.emptyBody")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onNewLocalTerminal}>
          {t("tabs.newLocalTerminal")}
        </Button>
      </div>
    );
  }

  return tabs.map((tab) => {
    const active = tab.id === activeId;
    return (
      <div
        key={tab.id}
        id={tabPanelId(tab.id)}
        role="tabpanel"
        aria-labelledby={tabId(tab.id)}
        hidden={!active}
        className="absolute inset-0"
      >
        <TabContent tab={tab} active={active} onTitleChange={(title) => onTitleChange(tab.id, title)} />
      </div>
    );
  });
}

function TabContent({
  tab,
  active,
  onTitleChange,
}: {
  tab: Tab;
  active: boolean;
  onTitleChange(title: string): void;
}) {
  switch (tab.kind) {
    case "local-terminal":
      return <LocalTerminalView active={active} onTitleChange={onTitleChange} />;
  }
}
