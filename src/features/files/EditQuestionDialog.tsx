import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FileBrowserState } from "./fileBrowserStore";

/**
 * Asks about a file the File panel did not open in the editor straight away: one over the size
 * limit can only be downloaded; one that looks binary can be downloaded or opened anyway.
 */
export function EditQuestionDialog({
  store,
  onDownload,
}: {
  store: StoreApi<FileBrowserState>;
  /** Downloads the remote file at this absolute path. */
  onDownload(path: string): void;
}) {
  const { t } = useTranslation();
  const question = useStore(store, (s) => s.editQuestion);
  const answer = (value: "open" | "cancel") => void store.getState().answerEditQuestion(value);
  const download = () => {
    if (question) onDownload(question.path);
    answer("cancel");
  };

  return (
    <Dialog open={question !== null} onOpenChange={(open) => !open && answer("cancel")}>
      {question && (
        <DialogContent showCloseButton={false} className="max-w-[calc(100%-2rem)] p-5 sm:max-w-120">
          <DialogHeader>
            <DialogTitle>{t(`files.edit.question.${question.reason}.title`)}</DialogTitle>
            <DialogDescription>
              {t(`files.edit.question.${question.reason}.body`, { name: question.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => answer("cancel")}>
              {t("files.edit.question.cancel")}
            </Button>
            {question.reason === "binary" && (
              <Button type="button" variant="outline" size="sm" onClick={() => answer("open")}>
                {t("files.edit.question.openAnyway")}
              </Button>
            )}
            <Button type="button" size="sm" autoFocus onClick={download}>
              {t("files.edit.question.download")}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
