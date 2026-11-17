import { useCallback, useMemo, useState, type ReactNode } from "react";
import { browserStore } from "@/lib/storage";
import { loadTerminalPrefs, normalizeTerminalPrefs, saveTerminalPrefs, type TerminalPrefs } from "./terminal-prefs";
import { TerminalPrefsContext } from "./terminal-prefs-context";

/** Holds the Terminal preferences for the whole app, loaded from and saved to local storage. */
export function TerminalPrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState(() => loadTerminalPrefs(browserStore()));

  const updatePrefs = useCallback((patch: Partial<TerminalPrefs>) => {
    setPrefs((current) => {
      const next = normalizeTerminalPrefs({ ...current, ...patch });
      saveTerminalPrefs(browserStore(), next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ prefs, updatePrefs }), [prefs, updatePrefs]);
  return <TerminalPrefsContext value={value}>{children}</TerminalPrefsContext>;
}
