import { CircleDot, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { terminalOutputKinds, terminalOutputs } from "./terminal-outputs";

export function TerminalOutputMenuItems({ paneId }: { paneId: string }) {
  const { t } = useTranslation();
  const terminal = useStore(terminalOutputs.store, (snapshot) => snapshot.get(paneId));
  if (!terminal) return null;
  return terminalOutputKinds.map((kind) => (
    <ContextMenuItem key={kind} onSelect={() => void terminalOutputs.toggle(paneId, kind)}>
      {kind === "log" ? <FileText /> : <CircleDot />}
      {t(`terminal.${kind}.${terminal[kind] ? "stop" : "start"}`)}
    </ContextMenuItem>
  ));
}
