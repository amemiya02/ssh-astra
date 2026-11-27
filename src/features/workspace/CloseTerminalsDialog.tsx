import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

export function CloseTerminalsDialog({ count, onCancel, onConfirm }: {
  count: number;
  onCancel(): void;
  onConfirm(skipConfirmation: boolean): void;
}) {
  const { t } = useTranslation();
  const [skipConfirmation, setSkipConfirmation] = useState(false);
  const skipId = useId();
  const cancel = useRef<HTMLButtonElement>(null);

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent showCloseButton={false} className="sm:max-w-100" onOpenAutoFocus={(event) => {
        event.preventDefault();
        cancel.current?.focus();
      }}>
        <DialogHeader>
          <DialogTitle>{t("tabs.confirmClose.title", { count })}</DialogTitle>
          <DialogDescription>{t("tabs.confirmClose.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Checkbox
            id={skipId}
            checked={skipConfirmation}
            onCheckedChange={(value) => setSkipConfirmation(value === true)}
          />
          <Label htmlFor={skipId} className="text-sm font-normal">{t("tabs.confirmClose.skip")}</Label>
        </div>
        <DialogFooter>
          <Button ref={cancel} variant="outline" onClick={onCancel}>{t("tabs.cancel")}</Button>
          <Button variant="destructive" onClick={() => onConfirm(skipConfirmation)}>
            {t("tabs.confirmClose.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
