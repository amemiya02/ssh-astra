import { useCallback } from "react";
import { getSetting, useSetting } from "@/lib/storage";
import { normalizeTerminalPrefs, terminalSetting, type TerminalPrefs } from "./terminal-prefs";

export interface TerminalPrefsValue {
  prefs: TerminalPrefs;
  /** Applies to every open Terminal at once and is saved to the settings file. */
  updatePrefs(patch: Partial<TerminalPrefs>): void;
}

/** Terminal preferences (font, size, ligatures, colour scheme, copy and paste). */
export function useTerminalPrefs(): TerminalPrefsValue {
  const [prefs, setPrefs] = useSetting(terminalSetting);
  const updatePrefs = useCallback(
    (patch: Partial<TerminalPrefs>) => {
      const current = getSetting(terminalSetting);
      const next = normalizeTerminalPrefs({ ...current, ...patch });
      if (patch.highlighting === undefined) next.highlighting = current.highlighting;
      setPrefs(next);
    },
    [setPrefs],
  );
  return { prefs, updatePrefs };
}
