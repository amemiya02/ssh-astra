import { defineSection, getSetting, setSetting } from "@/lib/storage";
import {
  isTerminalColorScheme,
  normalizeImportedTerminalSchemes,
  type ImportedTerminalScheme,
  type TerminalColorScheme,
} from "@/theme/terminal-themes";
import { defaultTerminalHighlighting, normalizeTerminalHighlighting, type TerminalHighlighting } from "./terminal-highlighting";

/**
 * How every Terminal looks and behaves. The Settings tab edits these
 * (`features/settings/terminal-section.tsx`); terminals read them with `useTerminalPrefs()`; a Host may override `colorScheme`
 * (`Host.terminalScheme`).
 */
export interface TerminalPrefs {
  /** A CSS font-family list; the first installed font wins. */
  fontFamily: string;
  /** In px, `minFontSize` to `maxFontSize`. */
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: (typeof cursorStyles)[number];
  cursorBlink: boolean;
  /** Literal characters that separate words when selecting with the mouse. */
  wordSeparator: string;
  titleSource: TerminalTitleSource;
  bell: (typeof terminalBellModes)[number];
  /** Draw programming ligatures (`->`, `!=`) when the font has them. */
  ligatures: boolean;
  colorScheme: TerminalColorScheme;
  importedSchemes: readonly ImportedTerminalScheme[];
  highlighting: TerminalHighlighting;
  /** Selecting text copies it to the clipboard. */
  copyOnSelect: boolean;
  /** Right-click pastes instead of opening the Terminal menu. */
  rightClickPaste: boolean;
  /**
   * Type the ShellIntegration hook into new remote bash/zsh shells so the File panel follows `cd`.
   * Read by the core too (`TerminalSettings`); applies to Terminals opened afterwards.
   */
  shellIntegration: boolean;
  /** Log output from newly opened Terminals. Read by the core. */
  autoLog: boolean;
  /** A user-selected directory for Terminal logs and Recordings. Null uses the app directory. */
  logDirectory: string | null;
  /** Ask before pasting more than one line (`PasteConfirmDialog`), since a shell runs each as it arrives. */
  confirmMultilinePaste: boolean;
}

export const minFontSize = 8;
export const maxFontSize = 32;
export const cursorStyles = ["block", "bar", "underline"] as const;
export const terminalBellModes = ["none", "flash", "sound"] as const;
export type TerminalTitleSource = "shell" | "host";

export const terminalNumberFields = {
  fontSize: { min: minFontSize, max: maxFontSize, step: 1 },
  fontWeight: { min: 100, max: 900, step: 100 },
  lineHeight: { min: 1, max: 2.5, step: 0.01 },
  letterSpacing: { min: 0, max: 5, step: 1 },
} as const;

export const defaultTerminalPrefs: TerminalPrefs = {
  fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  fontWeight: 400,
  lineHeight: 1.2,
  letterSpacing: 0,
  cursorStyle: "block",
  cursorBlink: true,
  wordSeparator: ' ()[]{}\',"`',
  titleSource: "shell",
  bell: "none",
  ligatures: false,
  colorScheme: "app",
  importedSchemes: [],
  highlighting: defaultTerminalHighlighting,
  copyOnSelect: true,
  rightClickPaste: true,
  shellIntegration: true,
  autoLog: false,
  logDirectory: null,
  confirmMultilinePaste: true,
};

/** The `terminal` section of the settings file. */
export const terminalSetting = defineSection<TerminalPrefs>("terminal", defaultTerminalPrefs, (raw) =>
  normalizeTerminalPrefs(typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}),
);

/** Changes the shared font size, including when several zoom events arrive before React renders. */
export function zoomTerminalFont(step: 1 | -1): void {
  const prefs = getSetting(terminalSetting);
  const fontSize = Math.min(maxFontSize, Math.max(minFontSize, prefs.fontSize + step));
  if (fontSize !== prefs.fontSize) setSetting(terminalSetting, { ...prefs, fontSize });
}

/** Coerces untrusted input (a saved value, a settings field) into valid preferences. */
export function normalizeTerminalPrefs(raw: Partial<Record<keyof TerminalPrefs, unknown>>): TerminalPrefs {
  const d = defaultTerminalPrefs;
  const importedSchemes = normalizeImportedTerminalSchemes(raw.importedSchemes);
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const fontFamily = typeof raw.fontFamily === "string" && raw.fontFamily.trim() ? raw.fontFamily.trim() : d.fontFamily;
  const bounded = (key: keyof typeof terminalNumberFields) => {
    const value = raw[key];
    const { min, max } = terminalNumberFields[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : d[key];
  };
  return {
    fontFamily,
    fontSize: Math.round(bounded("fontSize")),
    fontWeight: Math.round(bounded("fontWeight") / 100) * 100,
    lineHeight: Math.round(bounded("lineHeight") * 100) / 100,
    letterSpacing: Math.round(bounded("letterSpacing")),
    cursorStyle: cursorStyles.find((style) => style === raw.cursorStyle) ?? d.cursorStyle,
    cursorBlink: bool(raw.cursorBlink, d.cursorBlink),
    wordSeparator: typeof raw.wordSeparator === "string" && raw.wordSeparator && !/\p{Cc}/u.test(raw.wordSeparator)
      ? raw.wordSeparator
      : d.wordSeparator,
    titleSource: raw.titleSource === "host" ? "host" : d.titleSource,
    bell: terminalBellModes.find((mode) => mode === raw.bell) ?? d.bell,
    ligatures: bool(raw.ligatures, d.ligatures),
    colorScheme: isTerminalColorScheme(raw.colorScheme, importedSchemes) ? raw.colorScheme : d.colorScheme,
    importedSchemes,
    highlighting: normalizeTerminalHighlighting(raw.highlighting),
    copyOnSelect: bool(raw.copyOnSelect, d.copyOnSelect),
    rightClickPaste: bool(raw.rightClickPaste, d.rightClickPaste),
    shellIntegration: bool(raw.shellIntegration, d.shellIntegration),
    autoLog: bool(raw.autoLog, d.autoLog),
    logDirectory: typeof raw.logDirectory === "string" && raw.logDirectory.trim() ? raw.logDirectory : null,
    confirmMultilinePaste: bool(raw.confirmMultilinePaste, d.confirmMultilinePaste),
  };
}
