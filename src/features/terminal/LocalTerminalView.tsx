import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  closeTerminal,
  openLocalTerminal,
  resizeTerminal,
  writeTerminal,
  type TerminalId,
} from "@/lib/ipc/terminal";
import { XtermView } from "./XtermView";

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

interface LocalTerminalViewProps {
  /** Whether its tab is shown; becoming active refits and focuses the Terminal. */
  active?: boolean;
  /** The shell set a window title (OSC 0/2); an empty string clears it. */
  onTitleChange?(title: string): void;
}

/**
 * A Local terminal: an `XtermView` wired to a LocalPty in the Rust backend.
 * Stays mounted while its tab is hidden. When the shell exits or cannot start,
 * Enter starts a new one in the same tab.
 */
export function LocalTerminalView({ active = true, onTitleChange }: LocalTerminalViewProps) {
  const { t } = useTranslation();
  // Read through refs so a language change or a new callback never recreates the Terminal.
  const tRef = useRef(t);
  const onTitleChangeRef = useRef(onTitleChange);

  useEffect(() => {
    tRef.current = t;
    onTitleChangeRef.current = onTitleChange;
  });

  const attach = useCallback((xterm: XTerm) => {
    let id: TerminalId | undefined;
    let disposed = false;
    /** No shell attached: the next Enter starts one. */
    let waitingForRestart = false;
    const size = () => ({ cols: xterm.cols, rows: xterm.rows });

    const offerRestart = () => {
      id = undefined;
      waitingForRestart = true;
      xterm.options.cursorBlink = false;
      xterm.write(`${dim(tRef.current("terminal.pressEnterToRestart"))}\r\n`);
      onTitleChangeRef.current?.("");
    };

    const start = () => {
      waitingForRestart = false;
      xterm.options.cursorBlink = true;
      // The exit message can arrive before the open call resolves; this shell must not be adopted then.
      let exited = false;
      openLocalTerminal(size(), (event) => {
        if (event.type === "output") {
          xterm.write(event.data);
          return;
        }
        // Local terminals have no Connection.
        if (event.type === "connection") return;
        exited = true;
        const message =
          event.code === null
            ? tRef.current("terminal.exitedUnknown")
            : tRef.current("terminal.exited", { code: event.code });
        xterm.write(`\r\n${dim(message)}\r\n`);
        offerRestart();
      }).then(
        (opened) => {
          if (disposed || exited) {
            void closeTerminal(opened);
            return;
          }
          id = opened;
          // Catch up on any resize that happened while the shell was starting.
          void resizeTerminal(opened, size());
        },
        (error: unknown) => {
          const detail =
            typeof error === "object" && error && "message" in error ? String(error.message) : String(error);
          xterm.write(`\x1b[31m${tRef.current("terminal.failedToStart")}\x1b[0m\r\n`);
          xterm.write(`${dim(tRef.current("terminal.failureDetail", { message: detail }))}\r\n`);
          offerRestart();
        },
      );
    };
    start();

    const onData = xterm.onData((data) => {
      if (id !== undefined) void writeTerminal(id, data);
      else if (waitingForRestart && data === "\r") {
        xterm.write("\r\n");
        start();
      }
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

  return <XtermView active={active} onTitleChange={onTitleChange} attach={attach} />;
}
