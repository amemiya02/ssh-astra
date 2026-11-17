import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { readCommandError, type ConnectPrompt, type PromptAnswer } from "@/lib/ipc/connect";
import * as ipc from "@/lib/ipc/forwards";
import type { ForwardEvent, ForwardId, ForwardStatus } from "@/lib/ipc/forwards";
import type { HostId } from "@/lib/ipc/hosts";

/** The PortForwarder commands the store uses (`@/lib/ipc/forwards`); a fake in tests. */
export type ForwardsApi = Pick<typeof ipc, "watchForwards" | "startForward" | "stopForward">;

export interface ForwardsState {
  /** Every rule that is not stopped, by id. */
  states: Record<ForwardId, ForwardEvent>;
  /** Loads the current states and follows the backend's changes. Call once. */
  watch(): Promise<void>;
  /**
   * Starts a rule, connecting first if needed. A failed connect (other than
   * a cancel) is shown as the rule's error; rejects with the `CommandError`.
   */
  start(hostId: HostId, id: ForwardId, ask: (prompt: ConnectPrompt) => Promise<PromptAnswer>): Promise<void>;
  /** Stops a rule, or clears its error. */
  stop(id: ForwardId): Promise<void>;
}

const stopped: ForwardStatus = { state: "stopped" };

/** Port forward states as the UI sees them: pushed by the backend, never polled. */
export function createForwardsStore(api: ForwardsApi): StoreApi<ForwardsState> {
  return createStore<ForwardsState>()((set, get) => {
    const apply = (event: ForwardEvent) => {
      const states = { ...get().states };
      if (event.status.state === "stopped") delete states[event.forwardId];
      else states[event.forwardId] = event;
      set({ states });
    };
    return {
      states: {},

      async watch() {
        const now = await api.watchForwards(apply);
        for (const event of now) apply(event);
      },

      async start(hostId, id, ask) {
        try {
          await api.startForward(hostId, id, ask);
        } catch (e) {
          const error = readCommandError(e);
          // A listen failure already arrived as an event; a connect failure did not.
          if (error.kind !== "cancelled" && get().states[id]?.status.state !== "failed") {
            apply({ hostId, forwardId: id, status: { state: "failed", reason: error.message } });
          }
          throw error;
        }
      },

      async stop(id) {
        await api.stopForward(id);
        const event = get().states[id];
        if (event) apply({ ...event, status: stopped });
      },
    };
  });
}

export function statusOf(state: Pick<ForwardsState, "states">, id: ForwardId): ForwardStatus {
  return state.states[id]?.status ?? stopped;
}

/** Running rules, in the order they started. */
export function runningForwards(state: Pick<ForwardsState, "states">): ForwardEvent[] {
  return Object.values(state.states).filter((event) => event.status.state === "running");
}

/** The app's forwards store, backed by the Tauri PortForwarder commands. */
export const forwardsStore = createForwardsStore(ipc);

export function useForwards<T>(selector: (state: ForwardsState) => T): T {
  return useStore(forwardsStore, selector);
}
