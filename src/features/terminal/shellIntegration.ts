import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { followFileDirectory, type ShellIntegrationEvent, type ShellIntegrationStatus, type TerminalId } from "@/lib/ipc/terminal";
import { getSetting } from "@/lib/storage";
import { useTerminalPrefs } from "./terminal-prefs-context";
import { terminalSetting } from "./terminal-prefs";

type Status = ShellIntegrationStatus | "starting" | "disconnected";

interface PromptState {
  status: Status;
  /** True when a new, empty prompt has been positively identified. */
  atEmptyPrompt: boolean;
}

export interface FinishedShellCommand {
  commandLine: string | null;
  durationMs: number;
  exitCode: number;
}

export interface TrackedShell {
  prompt: PromptState;
  terminalId?: TerminalId;
  promptId?: number;
  /** Waiting for the first prompt or for a command to finish. */
  awaitingPrompt: boolean;
  /** Input may still be queued behind a prompt. */
  queuedInput: boolean;
  command?: { commandLine: string | null; startedAt: number };
}

const disconnected: PromptState = { status: "disconnected", atEmptyPrompt: false };
const disabled: PromptState = { status: "disabled", atEmptyPrompt: false };

export function createShellIntegrationState(enabled: () => boolean = () => true) {
  const store = createStore<ReadonlyMap<string, TrackedShell>>(() => new Map());
  const save = (paneId: string, next: TrackedShell) =>
    store.setState((panes) => new Map(panes).set(paneId, next), true);

  return {
    store,
    get(paneId: string): PromptState {
      return enabled() ? store.getState().get(paneId)?.prompt ?? disconnected : disabled;
    },
    canPasteAtPrompt(paneId: string): boolean {
      const current = store.getState().get(paneId);
      return enabled() && current?.terminalId !== undefined && current.prompt.status === "available"
        && !current.awaitingPrompt && !current.queuedInput;
    },
    open(paneId: string, terminalId?: TerminalId) {
      save(paneId, {
        prompt: { status: "starting", atEmptyPrompt: false },
        awaitingPrompt: true,
        queuedInput: false,
        terminalId,
      });
    },
    restore(paneId: string, state: TrackedShell) {
      save(paneId, state);
    },
    attach(paneId: string, terminalId: TerminalId) {
      const current = store.getState().get(paneId);
      if (current) save(paneId, { ...current, terminalId });
    },
    takeEmptyPrompt(paneId: string) {
      const current = store.getState().get(paneId);
      if (!enabled() || !current?.prompt.atEmptyPrompt || current.terminalId === undefined || current.promptId === undefined) return;
      save(paneId, { ...current, prompt: { ...current.prompt, atEmptyPrompt: false }, awaitingPrompt: true });
      return { terminalId: current.terminalId, promptId: current.promptId };
    },
    close(paneId: string) {
      store.setState((panes) => {
        if (!panes.has(paneId)) return panes;
        const next = new Map(panes);
        next.delete(paneId);
        return next;
      }, true);
    },
    event(paneId: string, event: ShellIntegrationEvent, normalBuffer = true): FinishedShellCommand | undefined {
      const current = store.getState().get(paneId);
      if (!current) return;
      if (event.type === "availability") {
        save(paneId, { ...current, prompt: { status: event.status, atEmptyPrompt: false }, command: undefined });
        return;
      }
      if (current.prompt.status !== "available") return;

      const atPrompt = event.type === "promptStart";
      const atEmptyPrompt = atPrompt && !current.queuedInput && normalBuffer;
      const tracking = enabled();
      const started = current.command;
      const finished = tracking && event.type === "commandEnd" && started ? {
        commandLine: started.commandLine,
        durationMs: performance.now() - started.startedAt,
        exitCode: event.exitCode,
      } : undefined;
      save(paneId, {
        prompt: { status: "available", atEmptyPrompt },
        terminalId: current.terminalId,
        promptId: atEmptyPrompt ? event.promptId : undefined,
        awaitingPrompt: !atPrompt,
        queuedInput: current.queuedInput,
        command: tracking && event.type === "commandStart"
          ? { commandLine: event.commandLine, startedAt: performance.now() }
          : undefined,
      });
      return finished;
    },
    input(paneId: string, data: string) {
      const current = store.getState().get(paneId);
      if (!current || data.length === 0) return;
      if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~") &&
        !/(?![\t\r\n])\p{Cc}/u.test(data.slice(6, -6))) {
        // A whole bracketed paste changes the line without submitting it.
        if (current.prompt.atEmptyPrompt) {
          save(paneId, { ...current, prompt: { ...current.prompt, atEmptyPrompt: false } });
        }
        return;
      }
      // The next marker can precede queued input reaching the editor. Trust a
      // later fresh prompt once Ctrl+C at the prompt has cleared the line.
      const interruptAt = data.indexOf("\x03");
      const canceledLine = !current.awaitingPrompt && data === "\x03";
      const queuedInput = !canceledLine && (current.queuedInput || current.awaitingPrompt
        || /[\r\n][\s\S]/.test(data) || (interruptAt !== -1 && interruptAt < data.length - 1));
      const awaitingPrompt = current.awaitingPrompt || interruptAt !== -1 || /[\r\n]/.test(data);
      if (current.prompt.atEmptyPrompt || awaitingPrompt !== current.awaitingPrompt || queuedInput !== current.queuedInput) {
        save(paneId, { ...current, prompt: { ...current.prompt, atEmptyPrompt: false }, awaitingPrompt, queuedInput });
      }
    },
    invalidatePrompt(paneId: string) {
      const current = store.getState().get(paneId);
      if (current?.prompt.atEmptyPrompt) {
        save(paneId, { ...current, prompt: { ...current.prompt, atEmptyPrompt: false } });
      }
    },
  };
}

/** Query a pane's current shell capabilities by its stable workspace ID. */
export const shellIntegration = createShellIntegrationState(() => getSetting(terminalSetting).shellIntegration);

/** File panel navigation is scoped to one pane and never routes through Broadcast. */
export function followTerminalDirectory(paneId: string, path: string) {
  const prompt = shellIntegration.takeEmptyPrompt(paneId);
  if (prompt) {
    void followFileDirectory(prompt.terminalId, prompt.promptId, path).catch(() => {
      // The Terminal can disappear between navigation and delivery. Do not replay a skipped cd.
    });
  }
}

export function useShellIntegration(paneId: string): PromptState {
  const { prefs } = useTerminalPrefs();
  const state = useStore(shellIntegration.store, (panes) => panes.get(paneId)?.prompt ?? disconnected);
  return prefs.shellIntegration ? state : disabled;
}
