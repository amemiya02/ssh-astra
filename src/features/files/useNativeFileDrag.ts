import type { DragStartEvent } from "@dnd-kit/core";
import { useCallback, useEffect, useRef } from "react";
import { showToast } from "@/features/toasts/toastStore";
import { readCommandError } from "@/lib/ipc/connect";
import { cancelFileDragExit, dragFileOut, waitForFileDragExit, type FilePromise } from "@/lib/ipc/files";
import { operationErrorText } from "./fileErrors";

declare global {
  interface Window {
    __sshastraFilePromises?: boolean;
  }
}

let latestGesture = 0;

/** Dnd-kit keeps the gesture inside the window, including moves and cross-Host copies. */
export function useNativeFileDrag() {
  const activeGesture = useRef<number | null>(null);
  const stop = useCallback(() => {
    const gesture = activeGesture.current;
    activeGesture.current = null;
    if (gesture !== null) void cancelFileDragExit(gesture).catch(() => {});
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
    // A webview reload resets module state while the native Window may survive.
    const gesture = Math.max(Date.now() * 1_000, latestGesture + 1);
    latestGesture = gesture;
    activeGesture.current = gesture;
    void waitForFileDragExit(gesture).then(async (outside) => {
      if (activeGesture.current !== gesture) return;
      activeGesture.current = null;
      if (outside) {
        // The native drag consumes the release after the pointer leaves the Window.
        document.dispatchEvent(new PointerEvent("pointercancel", { pointerId }));
        const copied = await dragFileOut(file);
        if (copied) showToast((t) => t("files.dragOut.copied", { name: file.name }));
      }
    }).catch((error: unknown) => {
      if (activeGesture.current === gesture) activeGesture.current = null;
      showToast((t) => t("files.dragOut.failed", {
        name: file.name, error: operationErrorText(t, readCommandError(error)),
      }), "error");
    });
  };
  return { track, stop };
}
