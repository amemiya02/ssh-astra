import { ChevronDown } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useLocalShells } from "./use-local-shells";

export function LocalShellMenu({ vertical, onSelect }: { vertical: boolean; onSelect(id: string): void }) {
  const { t } = useTranslation();
  const selected = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={t("terminal.localShell.choose")} tooltipSide={vertical ? "right" : "bottom"}>
          <ChevronDown />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label={t("terminal.localShell.choose")}
        side={vertical ? "right" : "bottom"}
        onCloseAutoFocus={(event) => {
          if (selected.current) event.preventDefault();
          selected.current = false;
        }}
      >
        <LocalShellMenuItems onSelect={(id) => {
          selected.current = true;
          onSelect(id);
        }} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LocalShellMenuItems({ onSelect }: { onSelect(id: string): void }) {
  const { t } = useTranslation();
  const shells = useLocalShells();
  if (typeof shells === "string" || shells.length === 0) {
    const status = typeof shells === "string" ? shells : "empty";
    return <DropdownMenuItem disabled>{t(`terminal.localShell.${status}`)}</DropdownMenuItem>;
  }
  return shells.map(({ id, label }) => (
    <DropdownMenuItem key={id} onSelect={() => onSelect(id)}>{label}</DropdownMenuItem>
  ));
}
