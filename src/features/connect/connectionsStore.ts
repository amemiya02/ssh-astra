import { createSnapshotWatch } from "@/lib/ipc/watchSnapshot";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { readCommandError, type ConnectPrompt, type PromptAnswer } from "@/lib/ipc/connect";
import * as ipc from "@/lib/ipc/connections";
import type { HeldEvent } from "@/lib/ipc/connections";
import type { HostId } from "@/lib/ipc/hosts";

/** The "Connect only" commands the store uses (`@/lib/ipc/connections`); a fake in tests. */
export type ConnectionsApi = Pick<typeof ipc, "watchConnections" | "connectHost" | "disconnectHost">;

export interface ConnectionsState {
  /** Hosts held connected by "Connect only", in the order they connected. */
  held: HostId[];
  /** Hosts a "Connect only" is in progress for. */
  connecting: HostId[];
  /** Loads the held Hosts and follows the backend's changes. Call once. */
  watch(): Promise<void>;
  /** Connects only (no Terminal); rejects with the `CommandError` if it fails. */
  connect(hostId: HostId, ask: (prompt: ConnectPrompt) => Promise<PromptAnswer>): Promise<void>;
  /** Ends "Connect only" on a Host. */
  disconnect(hostId: HostId): Promise<void>;
}

const without = (ids: HostId[], id: HostId) => ids.filter((other) => other !== id);

/** Held Connections as the UI sees them: pushed by the backend, never polled. */
export function createConnectionsStore(api: ConnectionsApi): StoreApi<ConnectionsState> {
  return createStore<ConnectionsState>()((set, get) => {
    const apply = ({ hostId, held }: HeldEvent) => {
      const rest = without(get().held, hostId);
      set({ held: held ? [...rest, hostId] : rest });
    };
    return {
      held: [],
      connecting: [],

      watch: createSnapshotWatch(
        api.watchConnections,
        (held) => set({ held }),
        apply,
      ),

      async connect(hostId, ask) {
        set({ connecting: [...without(get().connecting, hostId), hostId] });
        try {
          await api.connectHost(hostId, ask);
        } catch (e) {
          throw readCommandError(e);
        } finally {
          set({ connecting: without(get().connecting, hostId) });
        }
      },

      async disconnect(hostId) {
        await api.disconnectHost(hostId);
        apply({ hostId, held: false });
      },
    };
  });
}

/** The app's connections store, backed by the Tauri commands. */
export const connectionsStore = createConnectionsStore(ipc);

export function useConnections<T>(selector: (state: ConnectionsState) => T): T {
  return useStore(connectionsStore, selector);
}
