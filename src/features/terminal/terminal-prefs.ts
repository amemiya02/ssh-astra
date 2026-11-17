import { readItem, writeItem, type KeyValueStore } from "@/lib/storage";
import { isTerminalColorScheme, type TerminalColorScheme } from "@/theme/terminal-themes";

/**
 * How every Terminal looks and behaves. The Settings page renders and edits
 * these through `useTerminalPrefs()`; a Host may override `colorScheme`
 * (`Host.terminalScheme`).
 */
export interface TerminalPrefs {
  /** A CSS font-family list; the first installed font wins. */
  fontFamily: string;
  /** In px, `minFontSize` to `maxFontSize`. */
  fontSize: number;
  /** Draw programming ligatures (`->`, `!=`) when the font has them. */
  ligatures: boolean;
  colorScheme: TerminalColorScheme;
  /** Selecting text copies it to the clipboard. */
  copyOnSelect: boolean;
  /** Right-click pastes instead of doing nothing. */
  rightClickPaste: boolean;
}

export const minFontSize = 8;
export const maxFontSize = 32;

export const defaultTerminalPrefs: TerminalPrefs = {
  fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  ligatures: false,
  colorScheme: "app",
  copyOnSelect: true,
  rightClickPaste: true,
};

const prefsKey = "sshastra.terminal";

/** The saved preferences; anything missing or invalid falls back to its default. */
export function loadTerminalPrefs(store: KeyValueStore | undefined): TerminalPrefs {
  let saved: unknown;
  try {
    saved = JSON.parse(readItem(store, prefsKey) ?? "null");
  } catch {
    saved = null;
  }
  return normalizeTerminalPrefs(typeof saved === "object" && saved ? saved : {});
}

export function saveTerminalPrefs(store: KeyValueStore | undefined, prefs: TerminalPrefs): void {
  writeItem(store, prefsKey, JSON.stringify(prefs));
}

/** Coerces untrusted input (a saved value, a settings field) into valid preferences. */
export function normalizeTerminalPrefs(raw: Partial<Record<keyof TerminalPrefs, unknown>>): TerminalPrefs {
  const d = defaultTerminalPrefs;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const fontFamily = typeof raw.fontFamily === "string" && raw.fontFamily.trim() ? raw.fontFamily.trim() : d.fontFamily;
  const fontSize =
    typeof raw.fontSize === "number" && Number.isFinite(raw.fontSize)
      ? Math.min(maxFontSize, Math.max(minFontSize, Math.round(raw.fontSize)))
      : d.fontSize;
  return {
    fontFamily,
    fontSize,
    ligatures: bool(raw.ligatures, d.ligatures),
    colorScheme: isTerminalColorScheme(raw.colorScheme) ? raw.colorScheme : d.colorScheme,
    copyOnSelect: bool(raw.copyOnSelect, d.copyOnSelect),
    rightClickPaste: bool(raw.rightClickPaste, d.rightClickPaste),
  };
}
