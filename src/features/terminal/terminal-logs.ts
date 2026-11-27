import { createStore } from "zustand/vanilla";
import { showToast } from "@/features/toasts/toastStore";
import { readCommandError } from "@/lib/ipc/connect";
import { startTerminalLog, stopTerminalLog, type TerminalId, type TerminalLogStatus } from "@/lib/ipc/terminal";

interface LoggingTerminal {
  id: TerminalId;
  active: boolean;
}

const terminalLogStore = createStore<ReadonlyMap<string, LoggingTerminal>>()(() => new Map());

function update(paneId: string, terminal?: LoggingTerminal) {
  const current = terminalLogStore.getState();
  const existing = current.get(paneId);
  if (existing?.id === terminal?.id && existing?.active === terminal?.active) return;

  const next = new Map(current);
  if (terminal) next.set(paneId, terminal);
  else next.delete(paneId);
  terminalLogStore.setState(next, true);
}

function reportFailure(message: string) {
  showToast((t) => t("terminal.log.failed", { message }), "error");
}

export const terminalLogs = {
  store: terminalLogStore,

  /** One backend Terminal. Its first status can arrive before its id. */
  track(paneId: string) {
    let id: TerminalId | undefined;
    let active = false;
    return {
      attach(opened: TerminalId) {
        id = opened;
        update(paneId, { id, active });
      },
      status(status: TerminalLogStatus) {
        active = status.state === "active";
        if (id !== undefined && terminalLogStore.getState().get(paneId)?.id === id) {
          update(paneId, { id, active });
        }
        if (status.state === "failed") reportFailure(status.message);
      },
      close() {
        if (id !== undefined && terminalLogStore.getState().get(paneId)?.id === id) {
          update(paneId);
        }
      },
    };
  },

  async toggle(paneId: string) {
    const terminal = terminalLogStore.getState().get(paneId);
    if (!terminal) return;
    try {
      await (terminal.active ? stopTerminalLog(terminal.id) : startTerminalLog(terminal.id));
    } catch (error) {
      if (terminalLogStore.getState().get(paneId)?.id === terminal.id) {
        reportFailure(readCommandError(error).message);
      }
    }
  },
};
