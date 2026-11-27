import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useContext, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { BroadcastPaneContext } from "@/features/workspace/broadcast";
import { TabActivityContext } from "@/features/workspace/tab-activity";
import { e2eHooks } from "@/lib/e2e";
import {
  closeTerminal,
  resizeTerminal,
  writeTerminal,
  type TerminalEvent,
  type TerminalId,
  type TerminalSize,
} from "@/lib/ipc/terminal";
import { XtermView } from "./XtermView";
import { shellIntegration, useShellIntegration } from "./shellIntegration";

export type OpenTerminal = (
  size: TerminalSize,
  onEvent: (event: TerminalEvent) => void,
  signal: AbortSignal,
) => Promise<TerminalId>;

interface Props {
  paneId: string;
  /** Starts the backend Terminal. Called once, when the view mounts. */
  open: OpenTerminal;
  /** Called if `open` rejects; the view stays mounted. */
  onOpenError?: (error: unknown) => void;
  /** The backend Terminal is running. */
  onOpened?(id: TerminalId): void;
  /** The backend Terminal ended (its shell exited or its Connection dropped). */
  onExit?(): void;
  label: string;
  /** Whether its tab is shown; becoming active refits and focuses the Terminal. */
  active?: boolean;
  /** The Host's own colour scheme, overriding the global one. */
  colorScheme?: string | null;
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
  const { broadcast, tabId } = useContext(BroadcastPaneContext) ?? {};
  const { activity, tabId: activityTabId } = useContext(TabActivityContext) ?? {};
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
    const lifetime = new AbortController();
    let exited = false;
    let connected = true;
    let unregisterWriter: (() => void) | undefined;
    const sendInput = (id: TerminalId, data: string) => {
      shellIntegration.input(paneId, data);
      const write = writeTerminal(id, data);
      return e2eHooks ? write.then(() => e2eHooks?.trackInput(xterm, data.length)) : write;
    };
    const registerWriter = (opened: TerminalId) => {
      if (broadcast && tabId !== undefined && !unregisterWriter) {
        unregisterWriter = broadcast.register(tabId, paneId, (data) => {
          void sendInput(opened, data).catch(() => undefined);
        });
      }
    };
    const removeWriter = () => {
      unregisterWriter?.();
      unregisterWriter = undefined;
    };
    shellIntegration.open(paneId);
    const size = () => ({ cols: xterm.cols, rows: xterm.rows });

    openRef
      .current(size(), (event) => {
        if (lifetime.signal.aborted || exited) return;
        if (event.type === "output") {
          if (activityTabId !== undefined && event.data.length > 0) activity?.output(activityTabId);
          if (e2eHooks) e2eHooks.trackOutput(xterm, event.data);
          else xterm.write(event.data);
          return;
        }
        if (event.type === "shellIntegration") {
          shellIntegration.event(paneId, event.event, xterm.buffer.active.type === "normal");
          return;
        }
        if (event.type === "connection") {
          connected = event.state.state === "connected";
          if (connected) {
            shellIntegration.open(paneId);
            if (id !== undefined) registerWriter(id);
          } else {
            removeWriter();
            shellIntegration.close(paneId);
          }
          return;
        }
        if (event.type !== "exit") return;
        exited = true;
        removeWriter();
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
      }, lifetime.signal)
      .then(
        (opened) => {
          if (lifetime.signal.aborted || exited) {
            void closeTerminal(opened);
            return;
          }
          id = opened;
          if (connected) registerWriter(opened);
          onOpenedRef.current?.(opened);
          // Catch up on any resize that happened while connecting.
          void resizeTerminal(opened, size());
        },
        (error: unknown) => {
          if (lifetime.signal.aborted) return;
          shellIntegration.close(paneId);
          onOpenErrorRef.current?.(error);
        },
      );

    const onData = xterm.onData((data) => {
      if (id !== undefined) void sendInput(id, data);
    });
    const onBufferChange = xterm.buffer.onBufferChange((buffer) => {
      if (buffer.type === "alternate") shellIntegration.invalidatePrompt(paneId);
    });
    const onResize = xterm.onResize((next) => {
      if (id !== undefined) void resizeTerminal(id, next);
    });
    const onBell = xterm.onBell(() => {
      if (activityTabId !== undefined) activity?.bell(activityTabId);
    });

    return () => {
      lifetime.abort();
      removeWriter();
      onData.dispose();
      onResize.dispose();
      onBufferChange.dispose();
      onBell.dispose();
      shellIntegration.close(paneId);
      if (id !== undefined) void closeTerminal(id);
    };
  }, [activity, activityTabId, broadcast, paneId, tabId]);

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
