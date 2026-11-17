import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  closeTerminal,
  resizeTerminal,
  writeTerminal,
  type TerminalEvent,
  type TerminalId,
  type TerminalSize,
} from "@/lib/ipc/terminal";
import { useTheme } from "@/theme/theme-context";
import { terminalThemes } from "@/theme/terminal-themes";

const fontFamily = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace';

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
  /** The program set a window title (OSC 0/2); an empty string clears it. */
  onTitleChange?(title: string): void;
}

/**
 * xterm.js (WebGL) wired to any backend Terminal: input, resize (sent to the
 * backend so vim/tmux reflow), the app theme, and close on unmount.
 */
export function TerminalSurface({ open, onOpenError, onOpened, onExit, label, active = true, onTitleChange }: Props) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const themeRef = useRef(theme);
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
    const size = () => ({ cols: xterm.cols, rows: xterm.rows });

    openRef
      .current(size(), (event) => {
        if (event.type === "output") {
          xterm.write(event.data);
          return;
        }
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
      if (id !== undefined) void writeTerminal(id, data);
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

  return <div ref={containerRef} className="h-full w-full py-2 pr-1 pl-3" aria-label={label} />;
}
