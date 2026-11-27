import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fuzzyMatch } from "@/features/hosts/hostTree";
import { clearCommandHistory, listCommandHistory } from "@/lib/ipc/command-history";
import type { HostId } from "@/lib/ipc/hosts";

interface Props {
  hostId: HostId | undefined;
  onClose(): void;
  onCloseAutoFocus(event: Event): void;
  onPaste(command: string): "promptUnavailable" | "unsafePaste" | undefined;
}

export function CommandHistoryDialog({ hostId, onClose, onCloseAutoFocus, onPaste }: Props) {
  const { t } = useTranslation();
  return (
    <Dialog open={hostId !== undefined} onOpenChange={(open) => !open && onClose()}>
      {hostId !== undefined && (
        <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
          <DialogHeader>
            <DialogTitle>{t("terminal.commandHistory.title")}</DialogTitle>
            <DialogDescription>{t("terminal.commandHistory.description")}</DialogDescription>
          </DialogHeader>
          <HistoryList key={hostId} hostId={hostId} onPaste={onPaste} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function HistoryList({ hostId, onPaste }: { hostId: HostId; onPaste: Props["onPaste"] }) {
  const { t } = useTranslation();
  const [commands, setCommands] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<"loadFailed" | "clearFailed" | "promptUnavailable" | "unsafePaste" | null>(null);

  useEffect(() => {
    let active = true;
    void listCommandHistory(hostId).then(
      (history) => { if (active) setCommands(history); },
      () => {
        if (!active) return;
        setCommands([]);
        setError("loadFailed");
      },
    );
    return () => { active = false; };
  }, [hostId]);

  const clear = async () => {
    setClearing(true);
    setError(null);
    try {
      await clearCommandHistory(hostId);
      setCommands([]);
      setConfirming(false);
    } catch {
      setError("clearFailed");
    } finally {
      setClearing(false);
    }
  };

  const matches = commands?.flatMap((command, index) =>
    fuzzyMatch(command, query.trim()) ? [{ command, index }] : [],
  ) ?? [];
  const status = commands === null ? "loading" : !commands.length ? "empty" : "noMatches";
  return (
    <>
      <Command shouldFilter={false}>
        <CommandInput placeholder={t("terminal.commandHistory.search")} aria-label={t("terminal.commandHistory.search")} value={query} onValueChange={setQuery} autoFocus />
        <CommandList className="mt-2">
          {matches.map(({ command, index }) => (
            <CommandItem key={index} value={String(index)} onSelect={() => {
              setError(onPaste(command) ?? null);
            }} className="font-mono" disabled={clearing}>
              <span className="truncate whitespace-pre" dir="ltr" title={command}>{command}</span>
            </CommandItem>
          ))}
          {!matches.length && !error && <p role="status" className="text-muted-foreground px-2 py-4 text-sm">{t(`terminal.commandHistory.${status}`)}</p>}
        </CommandList>
      </Command>
      {error && <p role="alert" className="text-destructive text-sm">{t(`terminal.commandHistory.${error}`)}</p>}
      <DialogFooter>
        {confirming && (
          <Button variant="outline" size="sm" disabled={clearing} onClick={() => setConfirming(false)}>
            {t("terminal.commandHistory.cancel")}
          </Button>
        )}
        <Button variant={confirming ? "destructive" : "outline"} size="sm"
          disabled={commands === null || clearing || (!commands.length && error !== "loadFailed" && !confirming)}
          onClick={() => confirming ? void clear() : setConfirming(true)}>
          {t(confirming ? "terminal.commandHistory.confirmClear" : "terminal.commandHistory.clear")}
        </Button>
      </DialogFooter>
    </>
  );
}
