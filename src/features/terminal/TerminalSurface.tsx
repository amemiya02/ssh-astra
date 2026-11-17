import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
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

// Placeholder palettes until DESIGN.md defines terminal colour schemes.
const lightTheme: ITheme = { background: "#fafafa", foreground: "#27272a", cursor: "#27272a", selectionBackground: "#d4d4d8" };
const darkTheme: ITheme = { background: "#1c1c1f", foreground: "#e4e4e7", cursor: "#e4e4e7", selectionBackground: "#3f3f46" };
const darkQuery = "(prefers-color-scheme: dark)";

export type OpenTerminal = (size: TerminalSize, onEvent: (event: TerminalEvent) => void) => Promise<TerminalId>;

interface Props {
  /** Starts the backend Terminal. Called once, when the view mounts. */
  open: OpenTerminal;
  /** Called if `open` rejects; the view stays mounted. */
  onOpenError?: (error: unknown) => void;
  label: string;
}

/**
 * xterm.js (WebGL) wired to any backend Terminal, local or remote: input,
 * resize (sent to the backend so vim/tmux reflow) and close on unmount.
 */
export function TerminalSurface({ open, onOpenError, label }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  // The Terminal is opened once per mount; later prop changes don't reopen it.
  const openRef = useRef(open);
  const onOpenErrorRef = useRef(onOpenError);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const media = window.matchMedia(darkQuery);
    const xterm = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 10_000,
      theme: media.matches ? darkTheme : lightTheme,
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
    fit.fit();

    let id: TerminalId | undefined;
    let disposed = false;
    const size = () => ({ cols: xterm.cols, rows: xterm.rows });

    openRef
      .current(size(), (event) => {
        if (event.type === "output") {
          xterm.write(event.data);
        } else {
          const message =
            event.code === null ? t("terminal.exitedUnknown") : t("terminal.exited", { code: event.code });
          xterm.write(`\r\n\x1b[2m${message}\x1b[0m\r\n`);
        }
      })
      .then(
        (opened) => {
          if (disposed) {
            void closeTerminal(opened);
            return;
          }
          id = opened;
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

    const observer = new ResizeObserver(() => {
      // Hidden tabs measure 0×0; keep their last size instead.
      if (container.clientWidth > 0 && container.clientHeight > 0) fit.fit();
    });
    observer.observe(container);
    const onThemeChange = () => {
      xterm.options.theme = media.matches ? darkTheme : lightTheme;
    };
    media.addEventListener("change", onThemeChange);
    xterm.focus();

    return () => {
      disposed = true;
      media.removeEventListener("change", onThemeChange);
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      if (id !== undefined) void closeTerminal(id);
      xterm.dispose();
    };
  }, [t]);

  return <div ref={containerRef} className="h-full w-full p-2" aria-label={label} />;
}
