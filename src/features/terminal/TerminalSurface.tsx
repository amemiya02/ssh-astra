import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useContext, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { notifySystem } from "@/features/notifications/system-notifications";
import { BroadcastPaneContext } from "@/features/workspace/broadcast";
import { TabActivityContext } from "@/features/workspace/tab-activity";
import { e2eHooks } from "@/lib/e2e";
import type { HostId } from "@/lib/ipc/hosts";
import {
  answerAgentScreen,
  closeTerminal,
  resizeTerminal,
  saveClipboardImage,
  writeTerminal,
  type TerminalEvent,
  type TerminalId,
  type TerminalSize,
} from "@/lib/ipc/terminal";
import type { TransferHost } from "@/lib/ipc/transfers";
import { readAgentScreen } from "./agent-screen";
import { quoteDroppedPaths } from "./dropped-paths";
import { terminalPasteInput } from "./terminal-input";
import { XtermView } from "./XtermView";
import { shellIntegration, useShellIntegration } from "./shellIntegration";
import { terminalOutputs } from "./terminal-outputs";
import { notifyCommandFinished, watchTerminalNotifications } from "./terminal-notifications";

export type OpenTerminal = (
  size: TerminalSize,
  onEvent: (event: TerminalEvent) => void,
  signal: AbortSignal,
) => Promise<TerminalId>;

interface Props {
  paneId: string;
  host: TransferHost;
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
  historyHostId?: HostId;
  /** The program set a window title (OSC 0/2); an empty string clears it. */
  onTitleChange?(title: string): void;
}

/**
 * An `XtermView` wired to any backend Terminal: input, resize (sent to the
 * backend so vim/tmux reflow) and close on unmount.
 */
export function TerminalSurface({
  paneId,
  host,
  open,
  onOpenError,
  onOpened,
  onExit,
  label,
  active = true,
  colorScheme,
  historyHostId,
  onTitleChange,
}: Props) {
  const { t } = useTranslation();
  const { broadcast, tabId } = useContext(BroadcastPaneContext) ?? {};
  const { activity, tabId: activityTabId } = useContext(TabActivityContext) ?? {};
  const { status } = useShellIntegration(paneId);
  const unavailable = status === "disabled" || status === "unsupported" || status === "timedOut";
  // Read through refs: the Terminal is opened once per mount; later prop changes don't reopen it.
  const openRef = useRef(open);
  const hostRef = useRef(host);
  const imagePasteRef = useRef<(() => Promise<void>) | null>(null);
  const onOpenErrorRef = useRef(onOpenError);
  const onOpenedRef = useRef(onOpened);
  const onExitRef = useRef(onExit);
  const onTitleChangeRef = useRef(onTitleChange);
  const labelRef = useRef(label);
  const tRef = useRef(t);

  useEffect(() => {
    tRef.current = t;
    onOpenErrorRef.current = onOpenError;
    onOpenedRef.current = onOpened;
    onExitRef.current = onExit;
    onTitleChangeRef.current = onTitleChange;
    labelRef.current = label;
    hostRef.current = host;
  });

  const attach = useCallback((xterm: XTerm) => {
    let id: TerminalId | undefined;
    const lifetime = new AbortController();
    const stopNotifications = watchTerminalNotifications(xterm, (body) => {
      notifySystem({ category: "terminal", terminal: lifetime.signal }, (t) => ({
        title: t("notifications.terminal.title"),
        body,
      }));
    });
    let exited = false;
    let connected = true;
    let generation = 0;
    let unregisterWriter: (() => void) | undefined;
    const sendInput = (id: TerminalId, data: string, generation?: number) => {
      shellIntegration.input(paneId, data);
      const write = writeTerminal(id, data, generation);
      return e2eHooks ? write.then(() => e2eHooks?.trackInput(xterm, data.length)) : write;
    };
    const enableImagePaste = (opened: TerminalId) => {
      const sourceGeneration = generation;
      const paste = async () => {
        const path = await saveClipboardImage(opened, { host: hostRef.current, generation: sourceGeneration });
        if (path === null || imagePasteRef.current !== paste) return;
        const text = quoteDroppedPaths("sh", [path]);
        if (text === null) throw new Error("Cannot quote this path for the remote shell");
        const bracketed = xterm.modes.bracketedPasteMode && !xterm.options.ignoreBracketedPasteMode;
        await sendInput(opened, terminalPasteInput(text, bracketed, false), sourceGeneration);
      };
      imagePasteRef.current = paste;
    };
    const registerWriter = (opened: TerminalId) => {
      if (broadcast && tabId !== undefined && !unregisterWriter) {
        unregisterWriter = broadcast.register(
          tabId, paneId, (data) => sendInput(opened, data),
          () => xterm.modes.bracketedPasteMode && !xterm.options.ignoreBracketedPasteMode,
        );
      }
    };
    const removeWriter = () => {
      unregisterWriter?.();
      unregisterWriter = undefined;
    };
    shellIntegration.open(paneId);
    const output = terminalOutputs.track(paneId);
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
          const finished = shellIntegration.event(paneId, event.event, xterm.buffer.active.type === "normal");
          if (finished) notifyCommandFinished(labelRef.current, finished);
          return;
        }
        if (event.type === "connection") {
          connected = event.state.state === "connected";
          if (connected) {
            generation++;
            shellIntegration.open(paneId, id);
            if (id !== undefined) {
              enableImagePaste(id);
              registerWriter(id);
            }
          } else {
            imagePasteRef.current = null;
            removeWriter();
            shellIntegration.close(paneId);
          }
          return;
        }
        if (event.type === "terminalLog" || event.type === "recording") {
          output.status(event.type === "terminalLog" ? "log" : "recording", event.status);
          return;
        }
        if (event.type === "agentScreen") {
          const { requestId, scrollbackLines } = event.request;
          void answerAgentScreen(requestId, readAgentScreen(xterm, scrollbackLines)).catch(() => undefined);
          return;
        }
        if (event.type !== "exit") return;
        exited = true;
        imagePasteRef.current = null;
        removeWriter();
        output.close();
        if (id !== undefined) void closeTerminal(id).catch(() => undefined);
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
          shellIntegration.attach(paneId, opened);
          output.attach(opened);
          if (connected) {
            enableImagePaste(opened);
            registerWriter(opened);
          }
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
      imagePasteRef.current = null;
      output.close();
      stopNotifications();
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
        <XtermView label={label} active={active} colorScheme={colorScheme} onTitleChange={onTitleChange} imagePasteRef={imagePasteRef} attach={attach}
          historyHostId={historyHostId} canPasteHistory={() => shellIntegration.canPasteAtPrompt(paneId)} />
      </div>
      {unavailable && (
        <p className="border-border text-muted-foreground shrink-0 border-t px-3 py-1 text-xs" role="status">
          {t(`terminal.shellIntegration.${status}`)}
        </p>
      )}
    </div>
  );
}
