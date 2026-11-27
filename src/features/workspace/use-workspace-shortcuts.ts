import { createContext, useEffect, useMemo, useRef, type RefObject } from "react";
import { getResolvedShortcuts } from "./shortcut-settings";
import { matchShortcut, type KeyFocus, type Platform, type WorkspaceCommand } from "./shortcuts";

type Capture = (event: KeyboardEvent) => void;

export const ShortcutCaptureContext = createContext<{
  platform: Platform;
  capture: RefObject<Capture | null>;
} | null>(null);

/** Whether a key press is headed for a Terminal (xterm's hidden textarea lives inside `.xterm`). */
function keyFocus(target: EventTarget | null): KeyFocus {
  return target instanceof Element && target.closest(".xterm") ? "terminal" : "app";
}

/** Dispatches window shortcuts and gives the Settings recorder first use of the same key presses. */
export function useWorkspaceShortcuts(platform: Platform, run: (command: WorkspaceCommand) => void) {
  const runRef = useRef(run);
  const capture = useRef<Capture | null>(null);
  useEffect(() => {
    runRef.current = run;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (capture.current) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) capture.current(event);
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

  return useMemo(() => ({ platform, capture }), [platform]);
}
