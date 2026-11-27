import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { showToast } from "@/features/toasts/toastStore";
import { useOsFileDrop } from "@/features/transfers/use-os-file-drop";
import { BroadcastPaneContext } from "@/features/workspace/broadcast";
import { TabActivityContext } from "@/features/workspace/tab-activity";
import {
  closeTerminal,
  openLocalTerminal,
  resolveWslPaths,
  resizeTerminal,
  writeTerminal,
  type TerminalId,
} from "@/lib/ipc/terminal";
import { getSetting } from "@/lib/storage";
import { quoteDroppedPaths } from "./dropped-paths";
import { XtermView } from "./XtermView";
import { terminalPasteInput } from "./terminal-input";
import { terminalOutputs } from "./terminal-outputs";
import { terminalSetting } from "./terminal-prefs";

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

interface LocalTerminalViewProps {
  /** Whether this is the focused pane of the shown tab. Becoming active refits and focuses it. */
  active?: boolean;
  /** Non-focused splits in the shown tab can also receive dropped files. */
  visible?: boolean;
  initialCwd?: string;
  shellId?: string;
  onCwd?(cwd: string): void;
  /** The shell set a window title (OSC 0/2); an empty string clears it. */
  onTitleChange?(title: string): void;
}

/**
 * A Local terminal: an `XtermView` wired to a LocalPty in the Rust backend.
 * Stays mounted while its tab is hidden. When the shell exits or cannot start,
 * Enter starts a new one in the same tab.
 */
export function LocalTerminalView({ active = true, visible = active, initialCwd, shellId, onCwd, onTitleChange }: LocalTerminalViewProps) {
  const { t } = useTranslation();
  const [shellFallback, setShellFallback] = useState(false);
  const [running, setRunning] = useState(false);
  const dropTarget = useRef<HTMLDivElement>(null);
  const pasteDroppedPaths = useRef<((paths: string[]) => Promise<void>) | null>(null);
  const drop = useOsFileDrop(dropTarget, visible && running, (paths) => { void pasteDroppedPaths.current?.(paths); });
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
      pasteDroppedPaths.current = null;
      setRunning(false);
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
        if (event.type === "localShellFallback") {
          setShellFallback(true);
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
      }, cwd, shellId ?? getSetting(terminalSetting).localShell ?? undefined).then(
        ({ id: opened, shellProgram, wslDistribution }) => {
          if (disposed || exited) {
            void closeTerminal(opened);
            return;
          }
          id = opened;
          pasteDroppedPaths.current = async (paths) => {
            const isCurrent = () => !disposed && !exited && id === opened;
            const failed = () => {
              if (isCurrent()) showToast((t) => t("terminal.fileDrop.pasteFailed"), "error");
            };
            try {
              const input = wslDistribution ? await resolveWslPaths(wslDistribution, paths) : { shellProgram, paths };
              if (!isCurrent()) return;
              const text = input && quoteDroppedPaths(input.shellProgram, input.paths);
              if (text === null) return failed();
              const bracketed = xterm.modes.bracketedPasteMode && !xterm.options.ignoreBracketedPasteMode;
              await writeTerminal(opened, terminalPasteInput(text, bracketed, false));
            } catch {
              failed();
            }
          };
          setRunning(true);
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
        setShellFallback(false);
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
      pasteDroppedPaths.current = null;
      releaseOutput?.();
      unregisterWriter?.();
      pendingInput = "";
      onData.dispose();
      onResize.dispose();
      onBell.dispose();
      if (id !== undefined) void closeTerminal(id);
    };
  }, [activity, activityTabId, broadcast, paneId, shellId, tabId]);

  return (
    <div ref={dropTarget} className="relative flex h-full min-h-0 flex-col">
      {shellFallback && (
        <p role="status" className="bg-surface text-foreground shrink-0 border-b px-3 py-1.5 text-xs">
          {t("terminal.localShell.fallback")}
        </p>
      )}
      <div className="min-h-0 flex-1">
        <XtermView active={active} onTitleChange={onTitleChange} attach={attach} />
      </div>
      {drop.over && <span aria-hidden className="ring-primary pointer-events-none absolute inset-1 z-10 rounded-md ring-2 ring-inset" />}
    </div>
  );
}
