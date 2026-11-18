import { useEffect, useSyncExternalStore } from "react";

/** Something the command palette can run ("New Local terminal", "Open Settings"). */
export interface PaletteAction {
  /** Stable and unique, e.g. `settings.open`. */
  id: string;
  /** Already translated. */
  title: string;
  /** Other words that should find it, translated. */
  keywords?: string[];
  /** The chord shown beside it (`shortcutLabel(...)`), if it has one. */
  shortcut?: string;
  run(): void;
}

export interface ActionRegistry {
  /** Adds `actions` (an id already present is replaced in place). Returns the function that removes them. */
  register(actions: PaletteAction[]): () => void;
  list(): PaletteAction[];
  subscribe(listener: () => void): () => void;
}

export function createActionRegistry(): ActionRegistry {
  let entries: { action: PaletteAction; owner: symbol }[] = [];
  const listeners = new Set<() => void>();
  let snapshot: PaletteAction[] = [];
  const changed = () => {
    snapshot = entries.map((e) => e.action);
    for (const listener of listeners) listener();
  };

  return {
    register(actions) {
      const owner = Symbol();
      for (const action of actions) {
        const at = entries.findIndex((e) => e.action.id === action.id);
        if (at >= 0) entries[at] = { action, owner };
        else entries.push({ action, owner });
      }
      entries = [...entries];
      changed();
      return () => {
        entries = entries.filter((e) => e.owner !== owner);
        changed();
      };
    },
    list: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The palette's actions. A feature adds its own while it is mounted with `usePaletteActions`,
 * so the palette only offers what exists.
 */
export const paletteActions = createActionRegistry();

/**
 * Offers `actions` in the command palette while the calling component is mounted. Pass a
 * memoized array (`useMemo`): a new array re-registers.
 */
export function usePaletteActions(actions: PaletteAction[], registry: ActionRegistry = paletteActions): void {
  useEffect(() => registry.register(actions), [actions, registry]);
}

export function useRegisteredActions(registry: ActionRegistry = paletteActions): PaletteAction[] {
  return useSyncExternalStore(registry.subscribe, registry.list);
}
