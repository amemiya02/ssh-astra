import { createContext, useContext } from "react";
import type { TerminalPrefs } from "./terminal-prefs";

export interface TerminalPrefsContextValue {
  prefs: TerminalPrefs;
  /** Applies to every open Terminal at once and is saved for the next launch. */
  updatePrefs(patch: Partial<TerminalPrefs>): void;
}

export const TerminalPrefsContext = createContext<TerminalPrefsContextValue | null>(null);

/** Terminal preferences (font, size, ligatures, colour scheme, copy and paste). */
export function useTerminalPrefs(): TerminalPrefsContextValue {
  const value = useContext(TerminalPrefsContext);
  if (!value) throw new Error("useTerminalPrefs must be used inside <TerminalPrefsProvider>");
  return value;
}
