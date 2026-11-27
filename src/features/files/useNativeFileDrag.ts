import type { DragStartEvent } from "@dnd-kit/core";
import { useCallback, useEffect, useRef } from "react";
import { showToast } from "@/features/toasts/toastStore";
import { readCommandError } from "@/lib/ipc/connect";
import { dragFileOut, type FilePromise } from "@/lib/ipc/files";
import { operationErrorText } from "./fileErrors";

declare global {
  interface Window {
    __sshastraFilePromises?: boolean;
  }
}

/** Dnd-kit keeps the gesture inside the window, including moves and cross-Host copies. */
export function useNativeFileDrag() {
  const release = useRef<(() => void) | null>(null);
  const stop = useCallback(() => {
    release.current?.();
    release.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const track = ({ active, activatorEvent }: DragStartEvent) => {
    stop();
    if (!window.__sshastraFilePromises || !(activatorEvent instanceof PointerEvent) ||
        activatorEvent.pointerType !== "mouse" || activatorEvent.button !== 0) return;
    const source = active.data.current?.filePromise as (() => FilePromise | null) | undefined;
    const file = source?.();
    if (!file) return;

    const { pointerId } = activatorEvent;
    // The root stays mounted if the source row scrolls out of the virtual list.
    const capture = document.documentElement;
    const leave = (event: PointerEvent) => {
      if (event.pointerId !== pointerId || !(event.buttons & 1)) return;
      if (event.clientX >= 0 && event.clientY >= 0 &&
          event.clientX < window.innerWidth && event.clientY < window.innerHeight) return;
      stop();
      // The native drag consumes the release. Cancel the web sensor before starting it.
      document.dispatchEvent(new PointerEvent("pointercancel", { pointerId }));
      void dragFileOut(file).then((copied) => {
        if (copied) showToast((t) => t("files.dragOut.copied", { name: file.name }));
      }).catch((error: unknown) => {
        showToast((t) => t("files.dragOut.failed", {
          name: file.name, error: operationErrorText(t, readCommandError(error)),
        }), "error");
      });
    };
    release.current = () => {
      document.removeEventListener("pointermove", leave, true);
      document.removeEventListener("pointerout", leave, true);
      if (capture.hasPointerCapture(pointerId)) capture.releasePointerCapture(pointerId);
    };
    document.addEventListener("pointermove", leave, true);
    document.addEventListener("pointerout", leave, true);
    capture.setPointerCapture(pointerId);
  };
  return { track, stop };
}
