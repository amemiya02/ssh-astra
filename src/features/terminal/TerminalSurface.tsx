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

export type OpenTerminal = (size: TerminalSize, onEvent: (event: TerminalEvent) => void) => Promise<TerminalId>;

interface Props {
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
    const size = () => ({ cols: xterm.cols, rows: xterm.rows });

    openRef
      .current(size(), (event) => {
        if (event.type === "output") {
          if (e2eHooks) e2eHooks.trackOutput(xterm, event.data);
          else xterm.write(event.data);
          return;
        }
        // Remote Terminal views handle their Connection and directory before events reach here.
        if (event.type === "connection" || event.type === "cwd") return;
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
          if (disposed) {
            void closeTerminal(opened);
            return;
          }
          id = opened;
          onOpenedRef.current?.();
          // Catch up on any resize that happened while connecting.
          void resizeTerminal(opened, size());
        },
        (error: unknown) => onOpenErrorRef.current?.(error),
      );

    const onData = xterm.onData((data) => {
      if (id === undefined) return;
      const write = writeTerminal(id, data);
      if (e2eHooks) void write.then(() => e2eHooks?.trackInput(xterm, data.length));
    });
    const onResize = xterm.onResize((next) => {
      if (id !== undefined) void resizeTerminal(id, next);
    });

    return () => {
      disposed = true;
      onData.dispose();
      onResize.dispose();
      if (id !== undefined) void closeTerminal(id);
    };
  }, []);

  return (
    <XtermView label={label} active={active} colorScheme={colorScheme} onTitleChange={onTitleChange} attach={attach} />
  );
}
