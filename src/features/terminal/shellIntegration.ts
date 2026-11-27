import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { ShellIntegrationEvent, ShellIntegrationStatus } from "@/lib/ipc/terminal";
import { getSetting } from "@/lib/storage";
import { useTerminalPrefs } from "./terminal-prefs-context";
import { terminalSetting } from "./terminal-prefs";

type Status = ShellIntegrationStatus | "starting" | "disconnected";

interface PromptState {
  status: Status;
  /** True when a new, empty prompt has been positively identified. */
  atEmptyPrompt: boolean;
}

interface TrackedShell {
  prompt: PromptState;
  /** Waiting for the first prompt or for a command to finish. */
  awaitingPrompt: boolean;
  /** Input reached the PTY in the meantime and may still be queued. */
  queuedInput: boolean;
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
    open(paneId: string) {
      save(paneId, {
        prompt: { status: "starting", atEmptyPrompt: false },
        awaitingPrompt: true,
        queuedInput: false,
      });
    },
    close(paneId: string) {
      store.setState((panes) => {
        if (!panes.has(paneId)) return panes;
        const next = new Map(panes);
        next.delete(paneId);
        return next;
      }, true);
    },
    event(paneId: string, event: ShellIntegrationEvent, normalBuffer = true) {
      const current = store.getState().get(paneId);
      if (!current) return;
      if (event.type === "availability") {
        save(paneId, { ...current, prompt: { status: event.status, atEmptyPrompt: false } });
      } else if (current.prompt.status === "available") {
        const atPrompt = event.type === "promptStart";
        const atEmptyPrompt = atPrompt && !current.queuedInput && normalBuffer;
        save(paneId, {
          prompt: { status: "available", atEmptyPrompt },
          awaitingPrompt: !atPrompt,
          queuedInput: !atPrompt && current.queuedInput,
        });
      }
    },
    input(paneId: string, data: string) {
      const current = store.getState().get(paneId);
      if (!current) return;
      // Readline/ZLE may reinterpret editing keys. Wait for another prompt marker
      // after input, and skip that marker if the shell may still have typeahead.
      const queuedInput = current.queuedInput || current.awaitingPrompt || /[\r\n][^\r\n]/.test(data);
      if (current.prompt.atEmptyPrompt || queuedInput !== current.queuedInput) {
        save(paneId, { ...current, prompt: { ...current.prompt, atEmptyPrompt: false }, queuedInput });
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

export function useShellIntegration(paneId: string): PromptState {
  const { prefs } = useTerminalPrefs();
  const state = useStore(shellIntegration.store, (panes) => panes.get(paneId)?.prompt ?? disconnected);
  return prefs.shellIntegration ? state : disabled;
}
