import { CircleAlert, CircleCheck, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { IconButton } from "@/components/IconButton";
import { toastStore } from "./toastStore";

export function ToastRegion() {
  const { t } = useTranslation();
  const visible = useStore(toastStore, (state) => state.visible);
  const messages = visible.map(({ id, kind, message }) => ({ id, kind, text: message(t) }));

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="false">
        {messages.filter(({ kind }) => kind === "status").map(({ id, text }) => <p key={id}>{text}</p>)}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="false">
        {messages.filter(({ kind }) => kind === "error").map(({ id, text }) => <p key={id}>{text}</p>)}
      </div>
      {messages.length > 0 && (
        <ul className="pointer-events-none absolute right-3 bottom-2 z-40 flex max-h-[calc(100%-1rem)] w-88 max-w-[calc(100%-1.5rem)] flex-col gap-1.5 overflow-y-auto">
          {messages.map(({ id, kind, text }) => (
            <li key={id} className="bg-popover text-popover-foreground shadow-panel pointer-events-auto flex shrink-0 items-start gap-2 rounded-lg border p-2 pl-3">
              {kind === "error"
                ? <CircleAlert className="text-destructive mt-1 size-4 shrink-0" aria-hidden />
                : <CircleCheck className="text-success mt-1 size-4 shrink-0" aria-hidden />}
              <p className="min-w-0 flex-1 py-0.5 wrap-anywhere">{text}</p>
              <IconButton
                label={t("toast.dismiss", { message: text })}
                tooltipSide="left"
                onClick={() => toastStore.getState().dismiss(id)}
              >
                <X />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
