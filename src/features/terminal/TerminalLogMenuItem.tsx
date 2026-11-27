import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { terminalLogs } from "./terminal-logs";

export function TerminalLogMenuItem({ paneId }: { paneId: string }) {
  const { t } = useTranslation();
  const log = useStore(terminalLogs.store, (snapshot) => snapshot.get(paneId));
  if (!log) return null;
  return (
    <ContextMenuItem onSelect={() => void terminalLogs.toggle(paneId)}>
      <FileText />
      {t(log.active ? "terminal.log.stop" : "terminal.log.start")}
    </ContextMenuItem>
  );
}
