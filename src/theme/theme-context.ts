import { createContext, useContext } from "react";
import type { AppearanceSettings, ThemeChoice } from "./theme";
import type { AppTheme, AppThemeId, DarkThemeId, LightThemeId } from "./themes";

export interface ThemeContextValue {
  settings: AppearanceSettings;
  /** The theme actually painted: the preview while one is shown, else the saved choice resolved against the OS. */
  theme: AppTheme;
  /** Follow the system, or pin one theme. */
  setTheme(theme: ThemeChoice): void;
  /** The theme painted while following a light system. */
  setLightTheme(id: LightThemeId): void;
  /** The theme painted while following a dark system. */
  setDarkTheme(id: DarkThemeId): void;
  setZoom(percent: number): void;
  setFontFamily(fontFamily: string): void;
  /** Paints `id` across the window without saving it; `null` restores the saved theme. */
  preview(id: AppThemeId | null): void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
