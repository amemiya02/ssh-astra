import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  closeTerminal,
  openLocalTerminal,
  resizeTerminal,
  writeTerminal,
  type TerminalId,
} from "@/lib/ipc/terminal";
import { useTheme } from "@/theme/theme-context";
import { terminalThemes } from "@/theme/terminal-themes";

const fontFamily = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace';
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

interface LocalTerminalViewProps {
  /** Whether its tab is shown; becoming active refits and focuses the Terminal. */
  active?: boolean;
  /** The shell set a window title (OSC 0/2); an empty string clears it. */
  onTitleChange?(title: string): void;
}

/**
 * A Local terminal: xterm.js (WebGL) wired to a LocalPty in the Rust backend.
 * Stays mounted while its tab is hidden. When the shell exits or cannot start,
 * Enter starts a new one in the same tab.
 */
export function LocalTerminalView({ active = true, onTitleChange }: LocalTerminalViewProps) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const themeRef = useRef(theme);
  // Read through refs so a language change or a new callback never recreates the Terminal.
  const tRef = useRef(t);
  const onTitleChangeRef = useRef(onTitleChange);

  useEffect(() => {
    tRef.current = t;
    onTitleChangeRef.current = onTitleChange;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const xterm = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily,
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: terminalThemes[themeRef.current],
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(container);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose()); // falls back to the DOM renderer
      xterm.loadAddon(webgl);
    } catch {
      // WebGL unavailable: the DOM renderer is slower but correct.
    }
    // A hidden tab has no size; fitting it would shrink the shell to a sliver.
    const fitIfVisible = () => {
      if (container.clientWidth > 0 && container.clientHeight > 0) fit.fit();
    };
    fitIfVisible();
    xtermRef.current = xterm;
    fitRef.current = fit;

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
    const onTitle = xterm.onTitleChange((title) => onTitleChangeRef.current?.(title));

    const observer = new ResizeObserver(fitIfVisible);
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      onTitle.dispose();
      if (id !== undefined) void closeTerminal(id);
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    themeRef.current = theme;
    if (xtermRef.current) xtermRef.current.options.theme = terminalThemes[theme];
  }, [theme]);

  useEffect(() => {
    if (!active) return;
    fitRef.current?.fit();
    xtermRef.current?.focus();
  }, [active]);

  return <div ref={containerRef} className="h-full w-full py-2 pr-1 pl-3" />;
}
