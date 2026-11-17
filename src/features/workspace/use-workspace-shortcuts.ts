import { useEffect, useRef } from "react";
import { matchShortcut, type Platform, type WorkspaceCommand } from "./shortcuts";

/**
 * Runs workspace shortcuts from anywhere in the window, including a focused Terminal:
 * listens in the capture phase so a matched chord never reaches xterm.
 */
export function useWorkspaceShortcuts(platform: Platform, run: (command: WorkspaceCommand) => void) {
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const command = matchShortcut(event, platform);
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      runRef.current(command);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [platform]);
}
