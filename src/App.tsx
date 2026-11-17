import { useCallback, useReducer } from "react";
import { useTranslation } from "react-i18next";
import { FilePanel } from "@/features/files/FilePanel";
import { HostsSidebar } from "@/features/hosts/HostsSidebar";
import { AppShell } from "@/features/shell/AppShell";
import { TabPanels } from "@/features/workspace/TabPanels";
import { TabStrip } from "@/features/workspace/TabStrip";
import { emptyTabs, tabsReducer, type TabsState } from "@/features/workspace/tabs";

const newLocalTerminal = () => ({ id: crypto.randomUUID(), kind: "local-terminal" as const });

function initialTabs(): TabsState {
  return tabsReducer(emptyTabs, { type: "open", tab: newLocalTerminal() });
}

/**
 * Composes the main window. Each slot of `AppShell` is owned by a feature:
 * Host list (features/hosts), tabs (features/workspace), File panel (features/files).
 */
export function App() {
  const { t } = useTranslation();
  const [{ tabs, activeId }, dispatch] = useReducer(tabsReducer, undefined, initialTabs);

  const openLocalTerminal = useCallback(() => dispatch({ type: "open", tab: newLocalTerminal() }), []);

  return (
    <AppShell
      sidebar={<HostsSidebar onOpenLocalTerminal={openLocalTerminal} />}
      tabs={
        <TabStrip
          tabs={tabs}
          activeId={activeId}
          onActivate={(id) => dispatch({ type: "activate", id })}
          onClose={(id) => dispatch({ type: "close", id })}
          onNewLocalTerminal={openLocalTerminal}
        />
      }
      workspace={<TabPanels tabs={tabs} activeId={activeId} onNewLocalTerminal={openLocalTerminal} />}
      filePanel={<FilePanel />}
      status={<span>{t("status.noConnections")}</span>}
    />
  );
}
