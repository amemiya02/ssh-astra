import { defineSection, getSetting } from "@/lib/storage";

/** What the user asked for. `system` follows the OS light/dark setting. */
export type ThemePreference = "system" | "light" | "dark";

/** What is actually painted. */
export type Theme = "light" | "dark";

export const themePreferences: readonly ThemePreference[] = ["system", "light", "dark"];

export interface AppearanceSettings {
  theme: ThemePreference;
}

/** The `appearance` section of the settings file. */
export const appearanceSetting = defineSection<AppearanceSettings>("appearance", { theme: "system" }, (raw) => {
  const theme = (raw as { theme?: unknown } | null)?.theme;
  return { theme: themePreferences.find((p) => p === theme) ?? "system" };
});

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): Theme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

export const darkQuery = "(prefers-color-scheme: dark)";

export function systemPrefersDark(): boolean {
  return window.matchMedia(darkQuery).matches;
}

/** Applies the saved theme before React renders, so the first frame is already the right colour. */
export function applyInitialTheme(): void {
  applyTheme(document.documentElement, resolveTheme(getSetting(appearanceSetting).theme, systemPrefersDark()));
}

/** Paints `theme` on the document root: the `.dark` class drives the CSS tokens. */
export function applyTheme(root: HTMLElement, theme: Theme): void {
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}
