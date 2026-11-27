import type { TFunction } from "i18next";
import { CircleAlert, CircleCheck, FilePen, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { IconButton } from "@/components/IconButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { EditConflictAction, RemoteEditItem, RemoteEditKey } from "./sharedRemoteEdits";
import type { FileBrowserState } from "./fileBrowserStore";
import { errorText } from "./fileErrors";

/**
 * The files this File panel opened in the user's editor, each with how its last save went and,
 * after a failure, a retry. Shown under the file list while any is open.
 */
export function RemoteEdits({ store, hostName }: { store: StoreApi<FileBrowserState>; hostName: string }) {
  const { t } = useTranslation();
  const edits = useStore(store, (s) => s.edits);
  const [reviewing, setReviewing] = useState<RemoteEditKey | null>(null);
  const conflict = edits.find((edit) => edit.key === reviewing && edit.conflictId !== null);
  const resolving = conflict?.status === "resolvingConflict" || conflict?.status === "uploading";
  const choose = async (action: EditConflictAction) => {
    if (conflict && await store.getState().resolveEditConflict(conflict.key, action)) setReviewing(null);
  };
  if (edits.length === 0) return null;
  return (
    <section aria-label={t("files.edit.title")} className="shrink-0 border-t px-2 py-1.5">
      <ul className="flex flex-col gap-0.5">
        {edits.map((edit) => (
          <li key={edit.key} className="flex min-h-7 items-center gap-1.5 pl-1" title={edit.path}>
            <StatusIcon status={edit.status} />
            <div className="min-w-0 flex-1">
              <p className="truncate">{typeof edit.key === "number" ? t("files.edit.conflict.copyName", { name: edit.name }) : edit.name}</p>
              <p
                role={failed(edit) || edit.status === "conflict" ? "alert" : "status"}
                className={cn("truncate text-xs", failed(edit) || edit.error ? "text-destructive" : "text-muted-foreground")}
              >
                {statusText(t, edit, hostName)}
              </p>
            </div>
            {failed(edit) && (
              <Button variant="outline" size="sm" onClick={() => void store.getState().retryEdit(edit.key)}>
                {t("files.edit.retry")}
              </Button>
            )}
            {(edit.status === "conflict" || edit.status === "conflictPaused") && (
              <Button variant="outline" size="sm" onClick={() => setReviewing(edit.key)}>
                {t("files.edit.conflict.review")}
              </Button>
            )}
            <IconButton
              label={t("files.edit.close", { name: edit.name })}
              onClick={() => store.getState().closeEdit(edit.key)}
            >
              <X />
            </IconButton>
          </li>
        ))}
      </ul>
      <Dialog open={conflict !== undefined} onOpenChange={(open) => !open && !resolving && void choose("cancel")}>
        {conflict && (
          <DialogContent showCloseButton={false} className="max-w-[calc(100%-2rem)] p-5 sm:max-w-120">
            <DialogHeader>
              <DialogTitle>{t("files.edit.conflict.title")}</DialogTitle>
              <DialogDescription className="wrap-anywhere">
                {t("files.edit.conflict.body", { path: conflict.path, host: hostName })}
              </DialogDescription>
            </DialogHeader>
            {conflict.error && <p role="alert" className="text-destructive text-sm">{conflictErrorText(t, conflict.error)}</p>}
            <DialogFooter className="sm:flex-wrap">
              <Button type="button" variant="outline" size="sm" autoFocus disabled={resolving} onClick={() => void choose("cancel")}>
                {t("files.edit.question.cancel")}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={resolving} onClick={() => void choose("openRemote")}>
                {t("files.edit.conflict.openRemote")}
              </Button>
              <Button type="button" variant="destructive" size="sm" disabled={resolving} onClick={() => void choose("overwrite")}>
                {t("files.edit.conflict.overwrite")}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}

const failed = (edit: RemoteEditItem) => edit.status === "uploadFailed" || edit.status === "openFailed";

function StatusIcon({ status }: { status: RemoteEditItem["status"] }) {
  const className = "size-3.5 shrink-0";
  switch (status) {
    case "opening":
    case "uploading":
    case "resolvingConflict":
      return <LoaderCircle className={cn(className, "text-muted-foreground motion-safe:animate-spin")} aria-hidden />;
    case "uploaded":
      return <CircleCheck className={cn(className, "text-success")} aria-hidden />;
    case "uploadFailed":
    case "openFailed":
    case "conflict":
      return <CircleAlert className={cn(className, "text-destructive")} aria-hidden />;
    default:
      return <FilePen className={cn(className, "text-muted-foreground")} aria-hidden />;
  }
}

function statusText(t: TFunction, edit: RemoteEditItem, hostName: string): string {
  switch (edit.status) {
    case "opening":
      return t("files.edit.opening");
    case "editing":
      return t("files.edit.editing");
    case "uploading":
      return t("files.edit.uploading");
    case "uploaded":
      return t("files.edit.uploaded", { host: hostName });
    case "conflict":
      return edit.error ? conflictErrorText(t, edit.error) : t("files.edit.conflict.title");
    case "conflictPaused":
      return t("files.edit.conflict.paused");
    case "resolvingConflict":
      return t("files.edit.conflict.resolving");
    case "uploadFailed":
      return t("files.edit.uploadFailed", { message: edit.error?.message ?? "" });
    case "openFailed":
      switch (edit.error?.kind) {
        case "openFailed":
          return t("files.edit.noApplication");
        case "notFound":
          return t("files.edit.notFound");
        case "notAFile":
          return t("files.edit.notAFile");
        case "notConnected":
        case "permissionDenied":
        case "timedOut":
          return errorText(t, edit.error, hostName);
        default:
          return t("files.edit.openFailed", { message: edit.error?.message ?? "" });
      }
  }
}

function conflictErrorText(t: TFunction, error: NonNullable<RemoteEditItem["error"]>) {
  if (error.kind === "uploadFailed") return t("files.edit.uploadFailed", { message: error.message });
  if (error.kind === "editConflictExpired") return t("files.edit.conflict.changed");
  if (error.kind === "binary") return t("files.edit.question.binary.title");
  if (error.kind === "tooLarge") return t("files.edit.question.tooLarge.title");
  return t("files.edit.conflict.resolveFailed", { message: error.message });
}
