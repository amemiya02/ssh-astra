import { useCallback, useSyncExternalStore } from "react";

/**
 * The single access point for settings and UI preferences.
 *
 * They live in the versioned settings file (`settings.json` in the app config dir,
 * `sshastra_core::settings`), one JSON value per section. Each feature declares its
 * section next to its code with `defineSection` (key, defaults, a parser that repairs
 * whatever the file holds), reads it with `useSetting` / `getSetting`, and writes it with
 * the setter or `setSetting`. Changes apply at once and are saved in the background.
 */

/** A named section of the settings file, owned by one feature. */
export interface SettingsSection<T> {
  /** The section's key in the file. Never rename one without a file migration. */
  readonly key: string;
  readonly defaults: T;
  /** Turns whatever the file holds (missing, hand-edited, from another build) into a valid value. */
  parse(raw: unknown): T;
}

export function defineSection<T>(key: string, defaults: T, parse: (raw: unknown) => T): SettingsSection<T> {
  return { key, defaults, parse: (raw) => (raw === undefined ? defaults : parse(raw)) };
}

/** Where the settings file lives: the app (`lib/ipc/settings.ts`), localStorage in a browser, or memory in tests. */
export interface SettingsBackend {
  /** Every saved section by key. */
  load(): Promise<Record<string, unknown>>;
  /** Atomically loads the initial snapshot and subscribes to subsequent native writes. */
  watch?(receive: (event: SettingsChange) => void): Promise<Record<string, unknown>>;
  /** Replaces one section in the file. */
  save(section: string, value: unknown): Promise<SettingsChange | void>;
}

export interface SettingsChange {
  section: string;
  value: unknown;
  revision: number;
}

export interface Settings {
  get<T>(section: SettingsSection<T>): T;
  set<T>(section: SettingsSection<T>, value: T): void;
  commit<T>(section: SettingsSection<T>, value: T, immediate: boolean): Promise<void>;
  /** Called after any section changes. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  receive(event: SettingsChange): void;
  flush(): Promise<void>;
}

/** The slice of `Storage` used to move preferences out of localStorage. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem?(key: string, value: string): void;
  removeItem?(key: string): void;
}

function createSettings(backend: SettingsBackend, saved: Record<string, unknown>): Settings {
  const raw = { ...saved };
  const parsed = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const written = new Map<string, SettingsChange>();
  const pending = new Map<string, Promise<void>>();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  function publish<T>(section: SettingsSection<T>, value: T) {
    raw[section.key] = value;
    parsed.set(section.key, value);
    notify();
  }
  function apply({ section, value }: SettingsChange) {
    if (JSON.stringify(raw[section]) === JSON.stringify(value)) return;
    raw[section] = value;
    parsed.delete(section);
    notify();
  }
  function remember(event: SettingsChange) {
    if ((written.get(event.section)?.revision ?? 0) >= event.revision) return false;
    written.set(event.section, event);
    return true;
  }
  function save<T>(section: SettingsSection<T>, value: T, immediate: boolean): Promise<void> {
    const key = section.key;
    const write = () => backend.save(key, value);
    const previous = pending.get(key);
    const previousRevision = written.get(key)?.revision ?? 0;
    const saving = previous && backend.watch ? previous.catch(() => {}).then(write) : write();
    const completion = saving.then((event) => {
      if (event) remember(event);
      if (pending.get(key) !== completion) return;
      if (event) {
        const latest = written.get(key);
        if (latest) apply(latest);
      } else if (!immediate) {
        publish(section, value);
      }
    }, (error: unknown) => {
      const latest = written.get(key);
      if (pending.get(key) === completion && latest && latest.revision > previousRevision) apply(latest);
      throw error;
    }).finally(() => {
      if (pending.get(key) === completion) {
        pending.delete(key);
      }
    });
    pending.set(key, completion);
    return completion;
  }

  return {
    get<T>(section: SettingsSection<T>): T {
      if (!parsed.has(section.key)) parsed.set(section.key, section.parse(raw[section.key]));
      return parsed.get(section.key) as T;
    },
    set<T>(section: SettingsSection<T>, value: T) {
      publish(section, value);
      save(section, value, true).catch((error: unknown) => {
        console.warn(`Could not save the ${section.key} settings`, error);
      });
    },
    async commit<T>(section: SettingsSection<T>, value: T, immediate: boolean) {
      if (immediate) publish(section, value);
      await save(section, value, immediate);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    receive(event) {
      if (remember(event) && !pending.has(event.section)) apply(event);
    },
    async flush() {
      await Promise.allSettled(pending.values());
    },
  };
}

/**
 * Preferences that builds before the settings file kept in localStorage, by key, and the
 * section each one becomes. The values are imported as they were; the section's parser
 * repairs them on read.
 */
const legacyKeys: readonly { key: string; section: string; decode(raw: string): unknown }[] = [
  { key: "sshastra.theme", section: "appearance", decode: (raw) => ({ theme: raw }) },
  { key: "sshastra.layout.v1", section: "layout", decode: (raw) => JSON.parse(raw) as unknown },
  { key: "sshastra.terminal", section: "terminal", decode: (raw) => JSON.parse(raw) as unknown },
];

/** Copies localStorage preferences into sections the file does not have yet, then removes them. */
function importLegacy(saved: Record<string, unknown>, legacy: KeyValueStore): Record<string, unknown> {
  const imported: Record<string, unknown> = {};
  for (const { key, section, decode } of legacyKeys) {
    try {
      const value = legacy.getItem(key);
      if (value === null) continue;
      legacy.removeItem?.(key);
      if (section in saved || section in imported) continue;
      imported[section] = decode(value);
    } catch {
      // A value we cannot read is a lost preference, not a reason to fail.
    }
  }
  return imported;
}

/**
 * Loads the settings file. A file that cannot be read (damaged, from a newer build) gives
 * defaults for this session; the app keeps working and the file is left alone. Pass
 * `legacy` (localStorage) to move preferences saved by earlier builds into the file.
 */
export async function openSettings(backend: SettingsBackend, legacy?: KeyValueStore): Promise<Settings> {
  let saved: Record<string, unknown> = {};
  const changes: SettingsChange[] = [];
  let receive = (event: SettingsChange) => { changes.push(event); };
  let readable = true;
  try {
    saved = backend.watch
      ? await backend.watch((event) => receive(event))
      : await backend.load();
  } catch (error) {
    readable = false;
    console.warn("Could not read the settings file; using defaults", error);
  }
  const imported = readable && legacy ? importLegacy(saved, legacy) : {};
  for (const [section, value] of Object.entries(imported)) {
    backend.save(section, value).catch((error: unknown) => {
      console.warn(`Could not save the ${section} settings`, error);
    });
  }
  const settings = createSettings(backend, { ...saved, ...imported });
  receive = settings.receive;
  for (const event of changes) settings.receive(event);
  return settings;
}

const noBackend: SettingsBackend = { load: () => Promise.resolve({}), save: () => Promise.resolve() };

/** The app's settings: in-memory defaults until `startSettings` has loaded the file. */
let active: Settings = createSettings(noBackend, {});

/** Loads the settings file once at startup, before the first render. */
export async function startSettings(backend: SettingsBackend, legacy?: KeyValueStore): Promise<void> {
  active = await openSettings(backend, legacy);
}

export function getSetting<T>(section: SettingsSection<T>): T {
  return active.get(section);
}

export function setSetting<T>(section: SettingsSection<T>, value: T): void {
  active.set(section, value);
}

/** Applies a canonical reply from a dedicated native settings command. */
export function receiveSettingsChange(change: SettingsChange): void {
  active.receive(change);
}

export function flushSettings(): Promise<void> {
  return active.flush();
}

/** Waits for a preference with native side effects. Revocation can apply locally first. */
export function commitSetting<T>(section: SettingsSection<T>, value: T, immediate = false): Promise<void> {
  return active.commit(section, value, immediate);
}

/** Calls `listener` with the section's value whenever it changes. Returns the unsubscribe function. */
export function watchSetting<T>(section: SettingsSection<T>, listener: (value: T) => void): () => void {
  let last = active.get(section);
  return active.subscribe(() => {
    const next = active.get(section);
    if (next !== last) listener((last = next));
  });
}

/** A section's value and its setter; the component re-renders when the section changes. */
export function useSetting<T>(section: SettingsSection<T>): [T, (value: T) => void] {
  const value = useSyncExternalStore(
    (onChange) => active.subscribe(onChange),
    () => active.get(section),
  );
  const set = useCallback((next: T) => active.set(section, next), [section]);
  return [value, set];
}

/** `window.localStorage`, or undefined where it is not available. */
export function browserStore(): KeyValueStore | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Settings in localStorage, for running the front end in a plain browser (`pnpm dev`). */
export function localStorageBackend(store: KeyValueStore | undefined, key = "sshastra.settings"): SettingsBackend {
  const read = (): Record<string, unknown> => {
    const raw = store?.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  };
  return {
    load: () => Promise.resolve().then(read),
    save: (section, value) =>
      Promise.resolve().then(() => store?.setItem?.(key, JSON.stringify({ ...read(), [section]: value }))),
  };
}
