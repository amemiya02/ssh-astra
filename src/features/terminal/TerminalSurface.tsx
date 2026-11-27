import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { e2eHooks } from "@/lib/e2e";
import {
  closeTerminal,
  resizeTerminal,
  writeTerminal,
  type TerminalEvent,
  type TerminalId,
  type TerminalSize,
} from "@/lib/ipc/terminal";
import type { TerminalColorScheme } from "@/theme/terminal-themes";
import { XtermView } from "./XtermView";
import { shellIntegration, useShellIntegration } from "./shellIntegration";

export type OpenTerminal = (size: TerminalSize, onEvent: (event: TerminalEvent) => void) => Promise<TerminalId>;

interface Props {
  paneId: string;
  /** Starts the backend Terminal. Called once, when the view mounts. */
  open: OpenTerminal;
  /** Called if `open` rejects; the view stays mounted. */
  onOpenError?: (error: unknown) => void;
  /** The backend Terminal is running. */
  onOpened?(): void;
  /** The backend Terminal ended (its shell exited or its Connection dropped). */
  onExit?(): void;
  label: string;
  /** Whether its tab is shown; becoming active refits and focuses the Terminal. */
  active?: boolean;
  /** The Host's own colour scheme, overriding the global one. */
  colorScheme?: TerminalColorScheme;
  /** The program set a window title (OSC 0/2); an empty string clears it. */
  onTitleChange?(title: string): void;
}

/**
 * An `XtermView` wired to any backend Terminal: input, resize (sent to the
 * backend so vim/tmux reflow) and close on unmount.
 */
export function TerminalSurface({
  paneId,
  open,
  onOpenError,
  onOpened,
  onExit,
  label,
  active = true,
  colorScheme,
  onTitleChange,
}: Props) {
  const { t } = useTranslation();
  const { status } = useShellIntegration(paneId);
  const unavailable = status === "disabled" || status === "unsupported" || status === "timedOut";
  // Read through refs: the Terminal is opened once per mount; later prop changes don't reopen it.
  const openRef = useRef(open);
  const onOpenErrorRef = useRef(onOpenError);
  const onOpenedRef = useRef(onOpened);
  const onExitRef = useRef(onExit);
  const onTitleChangeRef = useRef(onTitleChange);
  const tRef = useRef(t);

  useEffect(() => {
    tRef.current = t;
    onOpenErrorRef.current = onOpenError;
    onOpenedRef.current = onOpened;
    onExitRef.current = onExit;
    onTitleChangeRef.current = onTitleChange;
  });

  const attach = useCallback((xterm: XTerm) => {
    let id: TerminalId | undefined;
    let disposed = false;
    let exited = false;
    shellIntegration.open(paneId);
    const size = () => ({ cols: xterm.cols, rows: xterm.rows });

    openRef
      .current(size(), (event) => {
        if (disposed || exited) return;
        if (event.type === "output") {
          if (e2eHooks) e2eHooks.trackOutput(xterm, event.data);
          else xterm.write(event.data);
          return;
        }
        if (event.type === "shellIntegration") {
          shellIntegration.event(paneId, event.event, xterm.buffer.active.type === "normal");
          return;
        }
        if (event.type === "connection") {
          if (event.state.state === "connected") shellIntegration.open(paneId);
          else shellIntegration.close(paneId);
          return;
        }
        if (event.type !== "exit") return;
        exited = true;
        id = undefined;
        shellIntegration.close(paneId);
        const message =
          event.code === null
            ? tRef.current("terminal.exitedUnknown")
            : tRef.current("terminal.exited", { code: event.code });
        xterm.write(`\r\n\x1b[2m${message}\x1b[0m\r\n`);
        xterm.options.cursorBlink = false;
        onTitleChangeRef.current?.("");
        onExitRef.current?.();
      })
      .then(
        (opened) => {
          if (disposed || exited) {
            void closeTerminal(opened);
            return;
          }
          id = opened;
          onOpenedRef.current?.();
          // Catch up on any resize that happened while connecting.
          void resizeTerminal(opened, size());
        },
        (error: unknown) => {
          if (disposed) return;
          shellIntegration.close(paneId);
          onOpenErrorRef.current?.(error);
        },
      );

    const onData = xterm.onData((data) => {
      if (id === undefined) return;
      shellIntegration.input(paneId, data);
      const write = writeTerminal(id, data);
      if (e2eHooks) void write.then(() => e2eHooks?.trackInput(xterm, data.length));
    });
    const onBufferChange = xterm.buffer.onBufferChange((buffer) => {
      if (buffer.type === "alternate") shellIntegration.invalidatePrompt(paneId);
    });
    const onResize = xterm.onResize((next) => {
      if (id !== undefined) void resizeTerminal(id, next);
    });

    return () => {
      disposed = true;
      onData.dispose();
      onResize.dispose();
      onBufferChange.dispose();
      shellIntegration.close(paneId);
      if (id !== undefined) void closeTerminal(id);
    };
  }, [paneId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <XtermView label={label} active={active} colorScheme={colorScheme} onTitleChange={onTitleChange} attach={attach} />
      </div>
      {unavailable && (
        <p className="border-border text-muted-foreground shrink-0 border-t px-3 py-1 text-xs" role="status">
          {t(`terminal.shellIntegration.${status}`)}
        </p>
      )}
    </div>
  );
}
