import { createContext, useCallback, useEffect, useMemo, useRef } from "react";
import { getResolvedShortcuts } from "./shortcut-settings";
import { matchShortcut, type KeyFocus, type Platform, type WorkspaceCommand } from "./shortcuts";

type Capture = (event: KeyboardEvent) => void;

export const ShortcutCaptureContext = createContext<{
  platform: Platform;
  registerCapture(target: EventTarget, handler: Capture): () => void;
} | null>(null);

/** Whether a key press is headed for a Terminal (xterm's hidden textarea lives inside `.xterm`). */
function keyFocus(target: EventTarget | null): KeyFocus {
  return target instanceof Element && target.closest(".xterm") ? "terminal" : "app";
}

/** Dispatches window shortcuts and gives the Settings recorder first use of the same key presses. */
export function useWorkspaceShortcuts(platform: Platform, run: (command: WorkspaceCommand) => void) {
  const runRef = useRef(run);
  const capture = useRef<{ target: EventTarget; handler: Capture } | null>(null);
  const registerCapture = useCallback((target: EventTarget, handler: Capture) => {
    const recording = { target, handler };
    capture.current = recording;
    return () => {
      if (capture.current === recording) capture.current = null;
    };
  }, []);
  useEffect(() => {
    runRef.current = run;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const recording = capture.current;
      if (recording && recording.target === event.target) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) recording.handler(event);
        return;
      }
      const command = matchShortcut(event, getResolvedShortcuts(platform), keyFocus(event.target));
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      runRef.current(command);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [platform]);

  return useMemo(() => ({ platform, registerCapture }), [platform, registerCapture]);
}
