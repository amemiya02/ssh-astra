import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { dismissAgentReview, invalidateAgentReview, openAgentReview } from "@/features/agent/agent-review";
import { notifySystem } from "@/features/notifications/system-notifications";
import { BroadcastPaneContext } from "@/features/workspace/broadcast";
import { TabActivityContext } from "@/features/workspace/tab-activity";
import { incomingPane, movedTerminalReady, movingSourcePane, receiveMoveFence, registerMovableTerminal, restoreTerminalScreen } from "@/features/workspace/tab-window-move";
import { terminalCwds } from "@/features/files/terminalCwds";
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
import { getSetting, watchSetting } from "@/lib/storage";
import { readAgentScreen } from "./agent-screen";
import { quoteDroppedPaths } from "./dropped-paths";
import { terminalPasteInput } from "./terminal-input";
import { XtermView } from "./XtermView";
import { shellIntegration, useShellIntegration } from "./shellIntegration";
import { trackShellPromptInput } from "./shell-prompt-input";
import { terminalOutputs } from "./terminal-outputs";
import { notifyCommandFinished, watchTerminalNotifications } from "./terminal-notifications";
import { TerminalCompletionList } from "./TerminalCompletionList";
import { trackTerminalCompletion, type CompletionView } from "./terminal-completion";
import { terminalSetting } from "./terminal-prefs";
import { attachHistorySuggestions } from "./xterm-history-suggestions";

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
  const activeRef = useRef(active);
  const historyHostRef = useRef(historyHostId);
  const suggestionsRef = useRef<ReturnType<typeof attachHistorySuggestions> | null>(null);
  const completionRef = useRef<ReturnType<typeof trackTerminalCompletion> | null>(null);
  const [completionView, setCompletionView] = useState<{ view: CompletionView; textarea: HTMLTextAreaElement | undefined }>();
  const tRef = useRef(t);

  useEffect(() => {
    tRef.current = t;
    onOpenErrorRef.current = onOpenError;
    onOpenedRef.current = onOpened;
    onExitRef.current = onExit;
    onTitleChangeRef.current = onTitleChange;
    labelRef.current = label;
    hostRef.current = host;
    activeRef.current = active;
    historyHostRef.current = historyHostId;
    suggestionsRef.current?.refresh();
    completionRef.current?.refresh();
    invalidateAgentReview(paneId);
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
    const moved = incomingPane(paneId);
    let canResize = moved === undefined;
    let generation = moved?.generation ?? 0;
    let cwd = moved?.cwd;
    let reportedCwd: string | undefined;
    let unregisterMove: (() => void) | undefined;
    let unregisterWriter: (() => void) | undefined;
    const sendInput = (id: TerminalId, data: string, generation?: number) => {
      completion.close();
      suggestions.observeInput(shellIntegration.canPasteAtPrompt(paneId) ? promptInput.observeInput(data) : undefined);
      shellIntegration.input(paneId, data);
      const write = writeTerminal(id, data, generation);
      return e2eHooks ? write.then(() => e2eHooks?.trackInput(xterm, data.length)) : write;
    };
    const promptInput = trackShellPromptInput(xterm);
    const historyHost = () => {
      const prefs = getSetting(terminalSetting);
      if (id !== undefined && connected && !exited && !lifetime.signal.aborted && activeRef.current &&
        prefs.inlineSuggestions && prefs.commandHistory && prefs.shellIntegration && !movingSourcePane(paneId)) {
        return historyHostRef.current;
      }
    };
    const suggestions = attachHistorySuggestions(xterm, promptInput, {
      host: historyHost,
      atPrompt: () => shellIntegration.canPasteAtPrompt(paneId),
      insert: (suffix) => {
        if (id === undefined || historyHost() === undefined) return false;
        const bracketed = xterm.modes.bracketedPasteMode && !xterm.options.ignoreBracketedPasteMode;
        void sendInput(id, terminalPasteInput(suffix, bracketed, false), generation).catch(() => undefined);
        return true;
      },
    });
    suggestionsRef.current = suggestions;
    const completion = trackTerminalCompletion(xterm, {
      enabled: () => getSetting(terminalSetting).completionList && activeRef.current && !lifetime.signal.aborted,
      source: () => {
        if (!getSetting(terminalSetting).shellIntegration) return "integrationOff";
        if (id === undefined || !connected || exited || movingSourcePane(paneId) ||
          shellIntegration.get(paneId).status !== "available") return "integrationUnavailable";
        const input = shellIntegration.canPasteAtPrompt(paneId) && promptInput.read();
        return input && input.atEnd ? { id, generation, cwd, input } : "promptUnavailable";
      },
      show: (view) => setCompletionView(view && { view, textarea: xterm.textarea }),
      insert: (source, text) => {
        const bracketed = xterm.modes.bracketedPasteMode && !xterm.options.ignoreBracketedPasteMode;
        void sendInput(source.id, terminalPasteInput(text, bracketed, false), source.generation).catch(() => undefined);
      },
    });
    completionRef.current = completion;
    const stopSuggestionSettings = watchSetting(terminalSetting, () => {
      suggestions.refresh();
      completion.refresh();
    });
    const resetSuggestions = () => {
      promptInput.reset();
      suggestions.reset();
      completion.close();
    };
    const afterOutput = () => {
      promptInput.afterWrite();
      if (!lifetime.signal.aborted) {
        suggestions.refresh();
        completion.refresh();
      }
    };
    const enableImagePaste = (opened: TerminalId) => {
      const sourceGeneration = generation;
      const paste = async () => {
        const path = await saveClipboardImage(opened, { host: hostRef.current, generation: sourceGeneration });
        if (path === null || imagePasteRef.current !== paste || movingSourcePane(paneId)) return;
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
    const stopReview = shellIntegration.store.subscribe(() => invalidateAgentReview(paneId));
    const output = terminalOutputs.track(paneId);
    if (moved?.log) output.status("log", { state: "active" });
    if (moved?.recording) output.status("recording", { state: "active" });
    const size = () => ({ cols: xterm.cols, rows: xterm.rows });

    async function openSurface(onEvent: (event: TerminalEvent) => void) {
      if (moved) {
        await Promise.resolve();
        lifetime.signal.throwIfAborted();
        await restoreTerminalScreen(xterm, moved, lifetime.signal);
        if (moved.shell) {
          const { command } = moved.shell;
          shellIntegration.restore(paneId, {
            ...moved.shell,
            command: command && { ...command, startedAt: command.startedAt - performance.timeOrigin },
          });
        }
      }
      return openRef.current(size(), onEvent, lifetime.signal);
    }

    void openSurface((event) => {
      if (lifetime.signal.aborted || exited) return;
      if (event.type === "moveFence") {
        invalidateAgentReview(paneId, true);
        resetSuggestions();
        receiveMoveFence(paneId, event.token);
        return;
      }
      if (event.type === "output") {
        if (activityTabId !== undefined && event.data.length > 0) activity?.output(activityTabId);
        promptInput.beforeWrite();
        suggestions.hide();
        if (e2eHooks) e2eHooks.trackOutput(xterm, event.data, afterOutput);
        else xterm.write(event.data, afterOutput);
        return;
      }
      if (event.type === "cwd") {
        // The integration reports PWD before each prompt. Keep it paired with
        // that prompt instead of accepting a later standalone OSC 7 report.
        reportedCwd = event.path;
        return;
      }
      if (event.type === "shellIntegration") {
        if (event.event.type === "promptStart") {
          cwd = reportedCwd;
          reportedCwd = undefined;
        } else if (event.event.type === "commandStart") {
          cwd = undefined;
          reportedCwd = undefined;
        }
        const finished = shellIntegration.event(paneId, event.event, xterm.buffer.active.type === "normal");
        if (finished) notifyCommandFinished(labelRef.current, finished);
        suggestions.refresh();
        completion.refresh();
        return;
      }
      if (event.type === "connection") {
        connected = event.state.state === "connected";
        cwd = undefined;
        reportedCwd = undefined;
        resetSuggestions();
        invalidateAgentReview(paneId, true);
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
      if (event.type === "agentReview") {
        const request = event.request;
        const requestedGeneration = generation;
        openAgentReview({
          request,
          paneId,
          eligible: () => activeRef.current && connected && !exited && !lifetime.signal.aborted && id === request.terminalId
            && generation === requestedGeneration && !movingSourcePane(paneId)
            && (request.kind === "fileWrite"
              || (xterm.buffer.active.type === "normal" && shellIntegration.isEmptyPrompt(paneId, request.promptId))),
        });
        return;
      }
      if (event.type === "agentReviewClosed") {
        dismissAgentReview(event.id);
        return;
      }
      if (event.type === "agentScreen") {
        const { requestId, scrollbackLines } = event.request;
        void answerAgentScreen(requestId, readAgentScreen(xterm, scrollbackLines)).catch(() => undefined);
        return;
      }
      if (event.type !== "exit") return;
      exited = true;
      resetSuggestions();
      invalidateAgentReview(paneId, true);
      imagePasteRef.current = null;
      removeWriter();
      output.close();
      unregisterMove?.();
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
    }).then(
      (opened) => {
        if (lifetime.signal.aborted || exited) {
          void closeTerminal(opened);
          return;
        }
        id = opened;
        shellIntegration.attach(paneId, opened);
        suggestions.refresh();
        output.attach(opened);
        if (connected) {
          enableImagePaste(opened);
          registerWriter(opened);
        }
        unregisterMove = registerMovableTerminal(paneId, opened, xterm, () => {
          const shell = shellIntegration.store.getState().get(paneId);
          return {
            cwd: terminalCwds.lastReported(paneId),
            generation,
            shell: shell && {
              ...shell,
              command: shell.command && { ...shell.command, startedAt: performance.timeOrigin + shell.command.startedAt },
            },
          };
        });
        onOpenedRef.current?.(opened);
        if (moved?.cwd) terminalCwds.report(paneId, moved.cwd);
        // Catch up on any resize that happened while connecting or reattaching.
        const resize = () => {
          if (lifetime.signal.aborted || id !== opened) return;
          canResize = true;
          void resizeTerminal(opened, size());
        };
        if (moved) void movedTerminalReady(paneId)?.then(resize);
        else resize();
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
      if (id !== undefined && canResize) void resizeTerminal(id, next);
    });
    const onBell = xterm.onBell(() => {
      if (activityTabId !== undefined) activity?.bell(activityTabId);
    });

    return () => {
      lifetime.abort();
      suggestionsRef.current = null;
      completionRef.current = null;
      completion.dispose();
      stopSuggestionSettings();
      suggestions.dispose();
      promptInput.dispose();
      stopReview();
      invalidateAgentReview(paneId, true);
      imagePasteRef.current = null;
      output.close();
      stopNotifications();
      removeWriter();
      unregisterMove?.();
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
      <div className="relative min-h-0 flex-1">
        <XtermView label={label} active={active} colorScheme={colorScheme} onTitleChange={onTitleChange} imagePasteRef={imagePasteRef} attach={attach}
          historyHostId={historyHostId} canPasteHistory={() => shellIntegration.canPasteAtPrompt(paneId)}
          onTerminalKey={(event, shortcut) => {
            if (shortcut === "completionList" && completionRef.current?.open(event.repeat)) return true;
            if (completionRef.current?.key(event)) return true;
            return suggestionsRef.current?.accept(event) ?? false;
          }} />
        {completionView && active && <TerminalCompletionList {...completionView}
          accept={(candidate) => { completionRef.current?.accept(candidate); }} />}
      </div>
      {unavailable && (
        <p className="border-border text-muted-foreground shrink-0 border-t px-3 py-1 text-xs" role="status">
          {t(`terminal.shellIntegration.${status}`)}
        </p>
      )}
    </div>
  );
}
