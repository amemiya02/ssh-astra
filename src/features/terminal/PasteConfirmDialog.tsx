import { Fragment } from "react";
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
import type { PendingPaste } from "./terminal-input";

interface PasteConfirmDialogProps {
  paste: PendingPaste | null;
  onCloseAutoFocus?(event: Event): void;
  onConfirm(): void;
  onCancel(): void;
}

export function PasteConfirmDialog({ paste, onCloseAutoFocus, onConfirm, onCancel }: PasteConfirmDialogProps) {
  const { t } = useTranslation();
  const hasInvisibleCharacters = !!paste?.invisibleCharacters?.length;
  let previewOffset = 0;
  const markedText = paste?.invisibleCharacters?.map(({ character, offset, line, column }) => {
    const precedingText = paste.text.slice(previewOffset, offset);
    previewOffset = offset + character.length;
    const code = character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");

    return (
      <Fragment key={offset}>
        {precedingText}
        <mark
          dir="ltr"
          className="bg-warning/20 text-foreground rounded px-0.5 font-semibold"
          title={t("terminal.paste.invisiblePosition", { line, column })}
        >
          [U+{code}]
        </mark>
      </Fragment>
    );
  });

  return (
    <Dialog open={paste !== null} onOpenChange={(open) => !open && onCancel()}>
      {paste && (
        <DialogContent onCloseAutoFocus={onCloseAutoFocus} showCloseButton={false} className="max-w-[calc(100%-2rem)] p-5 sm:max-w-120">
          <DialogHeader>
            <DialogTitle>
              {hasInvisibleCharacters ? t("terminal.paste.invisibleTitle") : t("terminal.paste.title", { count: paste.lines })}
            </DialogTitle>
            <DialogDescription>
              {hasInvisibleCharacters && t("terminal.paste.invisibleBody")}
              {paste.lines > 1 && <span className="block">{t("terminal.paste.body")}</span>}
            </DialogDescription>
          </DialogHeader>
          <pre className="bg-muted max-h-48 overflow-auto rounded-lg border px-3.5 py-3 font-mono text-xs break-all whitespace-pre-wrap">
            {markedText}
            {paste.text.slice(previewOffset)}
          </pre>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" autoFocus={hasInvisibleCharacters} onClick={onCancel}>
              {t("terminal.paste.cancel")}
            </Button>
            <Button type="button" size="sm" autoFocus={!hasInvisibleCharacters} onClick={onConfirm}>
              {t("terminal.paste.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
