import { createStore } from "zustand/vanilla";
import { showToast } from "@/features/toasts/toastStore";
import { readCommandError } from "@/lib/ipc/connect";
import { setTerminalOutput, type TerminalId, type TerminalOutputKind, type TerminalOutputStatus } from "@/lib/ipc/terminal";

interface TerminalOutputs {
  id: TerminalId;
  log: boolean;
  recording: boolean;
}

const outputStore = createStore<ReadonlyMap<string, TerminalOutputs>>()(() => new Map());

function update(paneId: string, terminal?: TerminalOutputs) {
  const current = outputStore.getState();
  const existing = current.get(paneId);
  if (existing?.id === terminal?.id && existing?.log === terminal?.log && existing?.recording === terminal?.recording) return;

  const next = new Map(current);
  if (terminal) next.set(paneId, terminal);
  else next.delete(paneId);
  outputStore.setState(next, true);
}

function reportFailure(kind: TerminalOutputKind, message: string) {
  showToast((t) => t(`terminal.${kind}.failed`, { message }), "error");
}

export const terminalOutputKinds = ["log", "recording"] as const;

export const terminalOutputs = {
  store: outputStore,

  /** One backend Terminal. Its first status can arrive before its id. */
  track(paneId: string) {
    let id: TerminalId | undefined;
    const active = { log: false, recording: false };
    return {
      attach(opened: TerminalId) {
        id = opened;
        update(paneId, { id, ...active });
      },
      status(kind: TerminalOutputKind, status: TerminalOutputStatus) {
        active[kind] = status.state === "active";
        if (id !== undefined && outputStore.getState().get(paneId)?.id === id) {
          update(paneId, { id, ...active });
        }
        if (status.state === "failed") reportFailure(kind, status.message);
      },
      close() {
        if (id !== undefined && outputStore.getState().get(paneId)?.id === id) {
          update(paneId);
        }
      },
    };
  },

  async toggle(paneId: string, kind: TerminalOutputKind) {
    const terminal = outputStore.getState().get(paneId);
    if (!terminal) return;
    try {
      await setTerminalOutput(terminal.id, kind, terminal[kind] ? "stop" : "start");
    } catch (error) {
      if (outputStore.getState().get(paneId)?.id === terminal.id) {
        reportFailure(kind, readCommandError(error).message);
      }
    }
  },
};
