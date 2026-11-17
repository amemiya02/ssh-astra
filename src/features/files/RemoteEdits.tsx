import { CircleAlert, CircleCheck, FilePen, LoaderCircle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { IconButton } from "@/components/IconButton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FileBrowserState, RemoteEditItem } from "./fileBrowserStore";
import { errorText } from "./fileErrors";

/**
 * The files this File panel opened in the user's editor, each with how its last save went and,
 * after a failure, a retry. Shown under the file list while any is open.
 */
export function RemoteEdits({ store, hostName }: { store: StoreApi<FileBrowserState>; hostName: string }) {
  const { t } = useTranslation();
  const edits = useStore(store, (s) => s.edits);
  if (edits.length === 0) return null;
  return (
    <section aria-label={t("files.edit.title")} className="shrink-0 border-t px-2 py-1.5">
      <ul className="flex flex-col gap-0.5">
        {edits.map((edit) => (
          <li key={edit.path} className="flex min-h-7 items-center gap-1.5 pl-1" title={edit.path}>
            <StatusIcon status={edit.status} />
            <div className="min-w-0 flex-1">
              <p className="truncate">{edit.name}</p>
              <p
                role={failed(edit) ? "alert" : "status"}
                className={cn("truncate text-xs", failed(edit) ? "text-destructive" : "text-muted-foreground")}
              >
                {statusText(t, edit, hostName)}
              </p>
            </div>
            {failed(edit) && (
              <Button variant="outline" size="sm" onClick={() => void store.getState().retryEdit(edit.path)}>
                {t("files.edit.retry")}
              </Button>
            )}
            <IconButton
              label={t("files.edit.close", { name: edit.name })}
              onClick={() => store.getState().closeEdit(edit.path)}
            >
              <X />
            </IconButton>
          </li>
        ))}
      </ul>
    </section>
  );
}

const failed = (edit: RemoteEditItem) => edit.status === "uploadFailed" || edit.status === "openFailed";

function StatusIcon({ status }: { status: RemoteEditItem["status"] }) {
  const className = "size-3.5 shrink-0";
  switch (status) {
    case "opening":
    case "uploading":
      return <LoaderCircle className={cn(className, "text-muted-foreground motion-safe:animate-spin")} aria-hidden />;
    case "uploaded":
      return <CircleCheck className={cn(className, "text-success")} aria-hidden />;
    case "uploadFailed":
    case "openFailed":
      return <CircleAlert className={cn(className, "text-destructive")} aria-hidden />;
    default:
      return <FilePen className={cn(className, "text-muted-foreground")} aria-hidden />;
  }
}

function statusText(t: ReturnType<typeof useTranslation>["t"], edit: RemoteEditItem, hostName: string): string {
  switch (edit.status) {
    case "opening":
      return t("files.edit.opening");
    case "editing":
      return t("files.edit.editing");
    case "uploading":
      return t("files.edit.uploading");
    case "uploaded":
      return t("files.edit.uploaded", { host: hostName });
    case "uploadFailed":
      return t("files.edit.uploadFailed", { message: edit.error?.message ?? "" });
    case "openFailed":
      switch (edit.error?.kind) {
        case "openFailed":
          return t("files.edit.noApplication");
        case "notFound":
          return t("files.edit.notFound");
        case "notConnected":
        case "permissionDenied":
        case "timedOut":
          return errorText(t, edit.error, hostName);
        default:
          return t("files.edit.openFailed", { message: edit.error?.message ?? "" });
      }
  }
}
