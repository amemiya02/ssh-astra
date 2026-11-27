import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { InterruptionCounts } from "@/features/workspace/interruption-counts";
import { ReleaseNotes } from "./ReleaseNotes";

export function UpdateDialog({ version, notes, failure, interruptions, onInstall }: {
  version: string;
  notes?: string;
  failure?: string;
  interruptions: InterruptionCounts;
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
          <ul className="mt-1 list-disc pl-4 tabular-nums">
            <li>{t("updates.connections", { count: interruptions.connections })}</li>
            <li>{t("updates.transfers", { count: interruptions.transfers })}</li>
            <li>{t("status.forwardsCount", { count: interruptions.forwards })}</li>
          </ul>
        </div>
      </DialogDescription>
      <DialogFooter>
        <DialogClose asChild>
          <Button ref={later} variant="outline">{t("updates.later")}</Button>
        </DialogClose>
        <Button onClick={onInstall}>{t("updates.install")}</Button>
      </DialogFooter>
    </DialogContent>
  );
}
