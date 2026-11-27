import { createContext } from "react";
import { createStore } from "zustand/vanilla";

export type BroadcastScope = "tab" | "window";
type Mode = { scope: BroadcastScope; tabId: string };
type Writer = { tabId: string; write(data: string): void };

interface State {
  mode: Mode | null;
  writers: ReadonlyMap<string, Writer>;
}

export function isBroadcastRecipient({ mode, writers }: State, paneId: string): boolean {
  const writer = writers.get(paneId);
  return !!writer && !!mode && (mode.scope === "window" || mode.tabId === writer.tabId);
}

/** One in-memory Broadcast per window. A registration belongs to one live shell. */
export function createBroadcast() {
  const store = createStore<State>(() => ({ mode: null, writers: new Map() }));
  let activePaneId: string | undefined;
  let openPanes: ReadonlySet<string> = new Set();

  const stop = () => store.setState({ mode: null });

  return {
    store,
    stop,
    updateWorkspace(paneId: string | undefined, tabIds: readonly string[], paneIds: readonly string[]) {
      activePaneId = paneId;
      openPanes = new Set(paneIds);
      const { mode } = store.getState();
      if (mode && !tabIds.includes(mode.tabId)) stop();
    },
    toggle(scope: BroadcastScope, tabId: string) {
      const { mode } = store.getState();
      if (mode?.scope === scope && (scope === "window" || mode.tabId === tabId)) stop();
      else store.setState({ mode: { scope, tabId } });
    },
    register(tabId: string, paneId: string, write: Writer["write"]) {
      const writer = { tabId, write };
      store.setState(({ writers }) => ({ writers: new Map(writers).set(paneId, writer) }));
      return () => {
        const { writers } = store.getState();
        if (writers.get(paneId) !== writer) return;
        const remaining = new Map(writers);
        remaining.delete(paneId);
        store.setState({ writers: remaining });
      };
    },
    /** Freeze the audience before a paste can ask for approval. A reconnected shell is a new writer. */
    capture(paneId: string) {
      const state = store.getState();
      const { mode, writers } = state;
      if (activePaneId !== paneId || !isBroadcastRecipient(state, paneId)) return;
      const source = writers.get(paneId);
      const peers = [...writers].filter(([id]) => id !== paneId && openPanes.has(id) && isBroadcastRecipient(state, id));
      return {
        canPaste: () => activePaneId === paneId && store.getState().writers.get(paneId) === source,
        send(data: string) {
          const current = store.getState();
          if (current.mode !== mode || activePaneId !== paneId || current.writers.get(paneId) !== source) return;
          for (const [id, writer] of peers) {
            if (openPanes.has(id) && current.writers.get(id) === writer) writer.write(data);
          }
        },
      };
    },
  };
}

export type Broadcast = ReturnType<typeof createBroadcast>;

export const BroadcastPaneContext = createContext<{ broadcast: Broadcast; tabId: string; paneId: string } | undefined>(undefined);
