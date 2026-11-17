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

/**
 * A Local terminal: xterm.js (WebGL) wired to a LocalPty in the Rust backend.
 * Stays mounted while its tab is hidden; `active` refits and focuses it when shown.
 */
export function LocalTerminalView({ active = true }: { active?: boolean }) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const themeRef = useRef(theme);

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

    openLocalTerminal(size(), (event) => {
      if (event.type === "output") {
        xterm.write(event.data);
      } else {
        const message =
          event.code === null ? t("terminal.exitedUnknown") : t("terminal.exited", { code: event.code });
        xterm.write(`\r\n\x1b[2m${message}\x1b[0m\r\n`);
      }
    }).then(
      (opened) => {
        if (disposed) {
          void closeTerminal(opened);
          return;
        }
        id = opened;
        // Catch up on any resize that happened while the shell was starting.
        void resizeTerminal(opened, size());
      },
      (error: unknown) => {
        const message = typeof error === "object" && error && "message" in error ? String(error.message) : String(error);
        xterm.write(`\x1b[31m${t("terminal.failedToStart", { message })}\x1b[0m\r\n`);
      },
    );

    const onData = xterm.onData((data) => {
      if (id !== undefined) void writeTerminal(id, data);
    });
    const onResize = xterm.onResize((next) => {
      if (id !== undefined) void resizeTerminal(id, next);
    });

    const observer = new ResizeObserver(fitIfVisible);
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      if (id !== undefined) void closeTerminal(id);
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, [t]);

  useEffect(() => {
    themeRef.current = theme;
    if (xtermRef.current) xtermRef.current.options.theme = terminalThemes[theme];
  }, [theme]);

  useEffect(() => {
    if (!active) return;
    fitRef.current?.fit();
    xtermRef.current?.focus();
  }, [active]);

  return <div ref={containerRef} className="h-full w-full py-2 pl-3 pr-1" />;
}
