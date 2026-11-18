import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ConflictAnswer } from "@/lib/ipc/transfers";
import { firstConflict, transfersStore, useTransfers } from "./transfersStore";

/**
 * Asks what to do with a file that already exists at a transfer's destination, one question
 * at a time (oldest first). Closing it without an answer skips the file.
 */
export function ConflictDialog() {
  const { t } = useTranslation();
  const conflict = useTransfers((s) => firstConflict(s.transfers));
  const path = conflict?.state.type === "conflict" ? conflict.state.path : null;
  const answer = (value: ConflictAnswer) => {
    if (conflict) void transfersStore.getState().answer(conflict.id, value);
  };

  return (
    <Dialog open={path !== null} onOpenChange={(open) => !open && answer("skip")}>
      {path !== null && (
        <DialogContent showCloseButton={false} className="max-w-[calc(100%-2rem)] p-5 sm:max-w-130">
          <DialogHeader>
            <DialogTitle>{t("transfers.conflict.title")}</DialogTitle>
            <DialogDescription>{t("transfers.conflict.body")}</DialogDescription>
          </DialogHeader>
          <p className="bg-muted rounded-lg border px-3.5 py-3 font-mono text-xs break-all">{path}</p>
          <DialogFooter className="sm:justify-between">
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => answer("skipAll")}>
                {t("transfers.conflict.skipAll")}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => answer("overwriteAll")}>
                {t("transfers.conflict.overwriteAll")}
              </Button>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => answer("skip")}>
                {t("transfers.conflict.skip")}
              </Button>
              <Button type="button" size="sm" autoFocus onClick={() => answer("overwrite")}>
                {t("transfers.conflict.overwrite")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
