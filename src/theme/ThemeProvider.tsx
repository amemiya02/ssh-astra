import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useSetting } from "@/lib/storage";
import { appearanceSetting, applyTheme, darkQuery, resolveTheme, systemPrefersDark, type ThemePreference } from "./theme";
import { ThemeContext } from "./theme-context";

function subscribeToSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia(darkQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Follows the system light/dark setting unless the user picked one; repaints live on either change. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useSetting(appearanceSetting);
  const preference = appearance.theme;
  const systemDark = useSyncExternalStore(subscribeToSystemTheme, systemPrefersDark);
  const theme = resolveTheme(preference, systemDark);

  useEffect(() => applyTheme(document.documentElement, theme), [theme]);

  const setPreference = useCallback(
    (next: ThemePreference) => setAppearance({ ...appearance, theme: next }),
    [appearance, setAppearance],
  );

  const value = useMemo(() => ({ preference, theme, setPreference }), [preference, theme, setPreference]);
  return <ThemeContext value={value}>{children}</ThemeContext>;
}
