import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useContext, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { BroadcastPaneContext } from "@/features/workspace/broadcast";
import { TabActivityContext } from "@/features/workspace/tab-activity";
import {
  closeTerminal,
  openLocalTerminal,
  resizeTerminal,
  writeTerminal,
  type TerminalId,
} from "@/lib/ipc/terminal";
import { XtermView } from "./XtermView";
import { terminalOutputs } from "./terminal-outputs";

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

interface LocalTerminalViewProps {
  /** Whether its tab is shown; becoming active refits and focuses the Terminal. */
  active?: boolean;
  initialCwd?: string;
  onCwd?(cwd: string): void;
  /** The shell set a window title (OSC 0/2); an empty string clears it. */
  onTitleChange?(title: string): void;
}

/**
 * A Local terminal: an `XtermView` wired to a LocalPty in the Rust backend.
 * Stays mounted while its tab is hidden. When the shell exits or cannot start,
 * Enter starts a new one in the same tab.
 */
export function LocalTerminalView({ active = true, initialCwd, onCwd, onTitleChange }: LocalTerminalViewProps) {
  const { t } = useTranslation();
  const { broadcast, tabId, paneId } = useContext(BroadcastPaneContext) ?? {};
  const { activity, tabId: activityTabId } = useContext(TabActivityContext) ?? {};
  // Read through refs so a language change or a new callback never recreates the Terminal.
  const tRef = useRef(t);
  const onTitleChangeRef = useRef(onTitleChange);
  const onCwdRef = useRef(onCwd);
  const initialCwdRef = useRef(initialCwd);

  useEffect(() => {
    tRef.current = t;
    onTitleChangeRef.current = onTitleChange;
    onCwdRef.current = onCwd;
  });

  const attach = useCallback((xterm: XTerm) => {
    let id: TerminalId | undefined;
    let disposed = false;
    let unregisterWriter: (() => void) | undefined;
    let releaseOutput: (() => void) | undefined;
    // ConPTY can ask xterm for its cursor position before the open call returns an id.
    let pendingInput = "";
    /** No shell attached: the next Enter starts one. */
    let waitingForRestart = false;
    const size = () => ({ cols: xterm.cols, rows: xterm.rows });

    const offerRestart = () => {
      unregisterWriter?.();
      unregisterWriter = undefined;
      releaseOutput?.();
      releaseOutput = undefined;
      id = undefined;
      pendingInput = "";
      waitingForRestart = true;
      xterm.options.cursorBlink = false;
      xterm.write(`${dim(tRef.current("terminal.pressEnterToRestart"))}\r\n`);
      onTitleChangeRef.current?.("");
    };

    const start = (cwd?: string) => {
      waitingForRestart = false;
      xterm.options.cursorBlink = true;
      // The exit message can arrive before the open call resolves; this shell must not be adopted then.
      let exited = false;
      const output = paneId === undefined ? undefined : terminalOutputs.track(paneId);
      releaseOutput = output?.close;
      openLocalTerminal(size(), (event) => {
        if (disposed || exited) return;
        if (event.type === "output") {
          if (activityTabId !== undefined && event.data.length > 0) activity?.output(activityTabId);
          xterm.write(event.data);
          return;
        }
        if (event.type === "cwd") {
          onCwdRef.current?.(event.path);
          return;
        }
        if (event.type === "terminalLog" || event.type === "recording") {
          output?.status(event.type === "terminalLog" ? "log" : "recording", event.status);
          return;
        }
        // Local terminals have no Connection and no ShellIntegration.
        if (event.type !== "exit") return;
        exited = true;
        if (id !== undefined) void closeTerminal(id).catch(() => undefined);
        const message =
          event.code === null
            ? tRef.current("terminal.exitedUnknown")
            : tRef.current("terminal.exited", { code: event.code });
        xterm.write(`\r\n${dim(message)}\r\n`);
        offerRestart();
      }, cwd).then(
        (opened) => {
          if (disposed || exited) {
            void closeTerminal(opened);
            return;
          }
          id = opened;
          output?.attach(opened);
          if (pendingInput) {
            void writeTerminal(opened, pendingInput);
            pendingInput = "";
          }
          if (broadcast && tabId !== undefined && paneId !== undefined) {
            unregisterWriter = broadcast.register(
              tabId, paneId, (data) => writeTerminal(opened, data),
              () => xterm.modes.bracketedPasteMode && !xterm.options.ignoreBracketedPasteMode,
            );
          }
          // Catch up on any resize that happened while the shell was starting.
          void resizeTerminal(opened, size());
        },
        (error: unknown) => {
          if (disposed || exited) return;
          const detail =
            typeof error === "object" && error && "message" in error ? String(error.message) : String(error);
          xterm.write(`\x1b[31m${tRef.current("terminal.failedToStart")}\x1b[0m\r\n`);
          xterm.write(`${dim(tRef.current("terminal.failureDetail", { message: detail }))}\r\n`);
          offerRestart();
        },
      );
    };

    const onData = xterm.onData((data) => {
      if (id !== undefined) void writeTerminal(id, data);
      else if (!waitingForRestart) pendingInput += data;
      else if (data === "\r") {
        xterm.write("\r\n");
        start();
      }
    });
    const onResize = xterm.onResize((next) => {
      if (id !== undefined) void resizeTerminal(id, next);
    });
    const onBell = xterm.onBell(() => {
      if (activityTabId !== undefined) activity?.bell(activityTabId);
    });
    start(initialCwdRef.current);

    return () => {
      disposed = true;
      releaseOutput?.();
      unregisterWriter?.();
      pendingInput = "";
      onData.dispose();
      onResize.dispose();
      onBell.dispose();
      if (id !== undefined) void closeTerminal(id);
    };
  }, [activity, activityTabId, broadcast, paneId, tabId]);

  return <XtermView active={active} onTitleChange={onTitleChange} attach={attach} />;
}
