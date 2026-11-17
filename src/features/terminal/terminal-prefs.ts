import { defineSection } from "@/lib/storage";
import { isTerminalColorScheme, type TerminalColorScheme } from "@/theme/terminal-themes";

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
  /** Draw programming ligatures (`->`, `!=`) when the font has them. */
  ligatures: boolean;
  colorScheme: TerminalColorScheme;
  /** Selecting text copies it to the clipboard. */
  copyOnSelect: boolean;
  /** Right-click pastes instead of doing nothing. */
  rightClickPaste: boolean;
  /**
   * Type the ShellIntegration hook into new remote bash/zsh shells so the File panel follows `cd`.
   * Read by the core too (`TerminalSettings`); applies to Terminals opened afterwards.
   */
  shellIntegration: boolean;
  /** Ask before pasting more than one line (`PasteConfirmDialog`), since a shell runs each as it arrives. */
  confirmMultilinePaste: boolean;
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
  shellIntegration: true,
  confirmMultilinePaste: true,
};

/** The `terminal` section of the settings file. */
export const terminalSetting = defineSection<TerminalPrefs>("terminal", defaultTerminalPrefs, (raw) =>
  normalizeTerminalPrefs(typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}),
);

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
    shellIntegration: bool(raw.shellIntegration, d.shellIntegration),
    confirmMultilinePaste: bool(raw.confirmMultilinePaste, d.confirmMultilinePaste),
  };
}
