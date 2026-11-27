import { createContext } from "react";
import { createStore } from "zustand/vanilla";
import { terminalPasteInput } from "@/features/terminal/terminal-input";

export type BroadcastScope = "tab" | "window";
type Mode = { scope: BroadcastScope; tabId: string };
type Writer = {
  tabId: string;
  write(data: string): void | Promise<void>;
  bracketedPaste(): boolean;
};

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

  function captureRoute(paneId: string) {
    const state = store.getState();
    const { mode, writers } = state;
    const source = writers.get(paneId);
    if (activePaneId !== paneId || !source || !openPanes.has(paneId)) return;
    const peers = isBroadcastRecipient(state, paneId)
      ? [...writers].filter(([id]) => id !== paneId && openPanes.has(id) && isBroadcastRecipient(state, id))
      : [];
    return {
      source,
      broadcasts: isBroadcastRecipient(state, paneId),
      stillFocused: () => activePaneId === paneId && store.getState().writers.get(paneId) === source,
      livePeers() {
        const current = store.getState();
        if (current.mode !== mode) return [];
        return peers.flatMap(([id, writer]) =>
          openPanes.has(id) && current.writers.get(id) === writer ? [writer] : [],
        );
      },
    };
  }

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
    register(tabId: string, paneId: string, write: Writer["write"], bracketedPaste = () => false) {
      const writer: Writer = { tabId, write, bracketedPaste };
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
      const route = captureRoute(paneId);
      if (!route?.broadcasts) return;
      return {
        canPaste: route.stillFocused,
        send(data: string) {
          if (!route.stillFocused()) return;
          for (const writer of route.livePeers()) {
            void Promise.resolve(writer.write(data)).catch(() => undefined);
          }
        },
      };
    },
    /** Capture the focused shell and Broadcast audience before a Snippet can prompt for variables. */
    captureInput(paneId: string) {
      const route = captureRoute(paneId);
      if (!route) return;
      return {
        async send(text: string, enter: boolean) {
          if (!route.stillFocused()) return false;
          await Promise.all([route.source, ...route.livePeers()].map(async (writer) => {
            const data = terminalPasteInput(text, writer.bracketedPaste(), enter);
            if (data) await writer.write(data);
          }));
          return true;
        },
      };
    },
  };
}

export type Broadcast = ReturnType<typeof createBroadcast>;

export const BroadcastPaneContext = createContext<{ broadcast: Broadcast; tabId: string; paneId: string } | undefined>(undefined);
