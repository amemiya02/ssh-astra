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

export interface PendingPaste {
  text: string;
  lines: number;
}

interface PasteConfirmDialogProps {
  paste: PendingPaste | null;
  onConfirm(): void;
  onCancel(): void;
}

/** Asks before pasting several lines, since a shell runs each one as it arrives. */
export function PasteConfirmDialog({ paste, onConfirm, onCancel }: PasteConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={paste !== null} onOpenChange={(open) => !open && onCancel()}>
      {paste && (
        <DialogContent showCloseButton={false} className="max-w-[calc(100%-2rem)] p-5 sm:max-w-120">
          <DialogHeader>
            <DialogTitle>{t("terminal.paste.title", { count: paste.lines })}</DialogTitle>
            <DialogDescription>{t("terminal.paste.body")}</DialogDescription>
          </DialogHeader>
          <pre className="bg-muted max-h-48 overflow-auto rounded-lg border px-3.5 py-3 font-mono text-xs break-all whitespace-pre-wrap">
            {paste.text}
          </pre>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              {t("terminal.paste.cancel")}
            </Button>
            <Button type="button" size="sm" autoFocus onClick={onConfirm}>
              {t("terminal.paste.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
