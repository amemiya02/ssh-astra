import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InterruptionList } from "@/features/workspace/InterruptionList";
import type { InterruptionCounts } from "@/features/workspace/interruption-counts";
import { ReleaseNotes } from "./ReleaseNotes";

export function UpdateDialog({ version, notes, failure, interruptions, countingConnections, onInstall }: {
  version: string;
  notes?: string;
  failure?: string;
  interruptions: InterruptionCounts;
  countingConnections: boolean;
  onInstall(): void;
}) {
  const { t } = useTranslation();
  const later = useRef<HTMLButtonElement>(null);

  return (
    <DialogContent
      showCloseButton={false}
      className="max-h-[calc(100vh-2rem)] overflow-y-auto"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        later.current?.focus();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("updates.available", { version })}</DialogTitle>
      </DialogHeader>
      {failure !== undefined && <p role="alert" className="text-destructive text-sm">{t("updates.installFailed", { reason: failure })}</p>}
      <ReleaseNotes notes={notes} />
      <DialogDescription asChild>
        <div>
          <p>{t("updates.interruptions")}</p>
          <InterruptionList {...interruptions} />
        </div>
      </DialogDescription>
      <DialogFooter>
        <DialogClose asChild>
          <Button ref={later} variant="outline">{t("updates.later")}</Button>
        </DialogClose>
        <Button disabled={countingConnections} onClick={onInstall}>{t("updates.install")}</Button>
      </DialogFooter>
    </DialogContent>
  );
}
