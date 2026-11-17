import { createContext, useContext } from "react";
import type { Theme, ThemePreference } from "./theme";

export interface ThemeContextValue {
  preference: ThemePreference;
  /** The theme actually painted, after resolving `system`. */
  theme: Theme;
  setPreference(preference: ThemePreference): void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
