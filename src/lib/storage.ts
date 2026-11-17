/**
 * The slice of `Storage` that UI preferences need. Pass `window.localStorage` in
 * the app and a Map-backed fake in tests.
 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem?(key: string, value: string): void;
}

/** Reads a key, treating a missing or throwing store as "nothing saved". */
export function readItem(store: KeyValueStore | undefined, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Writes a key; a full or unavailable store loses the preference, never the app. */
export function writeItem(store: KeyValueStore | undefined, key: string, value: string): void {
  try {
    store?.setItem?.(key, value);
  } catch {
    // Preferences are a convenience; failing to save one must not break the UI.
  }
}

/** `window.localStorage`, or undefined where it is not available. */
export function browserStore(): KeyValueStore | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
