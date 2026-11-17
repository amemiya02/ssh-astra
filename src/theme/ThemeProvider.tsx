import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { browserStore } from "@/lib/storage";
import {
  applyTheme,
  darkQuery,
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
  systemPrefersDark,
  type ThemePreference,
} from "./theme";
import { ThemeContext } from "./theme-context";

function subscribeToSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia(darkQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Follows the system light/dark setting unless the user picked one; repaints live on either change. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(() => loadThemePreference(browserStore()));
  const systemDark = useSyncExternalStore(subscribeToSystemTheme, systemPrefersDark);
  const theme = resolveTheme(preference, systemDark);

  useEffect(() => applyTheme(document.documentElement, theme), [theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    saveThemePreference(browserStore(), next);
  }, []);

  const value = useMemo(() => ({ preference, theme, setPreference }), [preference, theme, setPreference]);
  return <ThemeContext value={value}>{children}</ThemeContext>;
}
