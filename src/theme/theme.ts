import { browserStore, readItem, writeItem, type KeyValueStore } from "@/lib/storage";

/** What the user asked for. `system` follows the OS light/dark setting. */
export type ThemePreference = "system" | "light" | "dark";

/** What is actually painted. */
export type Theme = "light" | "dark";

const preferenceKey = "sshastra.theme";
const preferences: readonly ThemePreference[] = ["system", "light", "dark"];

export function loadThemePreference(store: KeyValueStore | undefined): ThemePreference {
  const saved = readItem(store, preferenceKey);
  return preferences.find((p) => p === saved) ?? "system";
}

export function saveThemePreference(store: KeyValueStore | undefined, preference: ThemePreference): void {
  writeItem(store, preferenceKey, preference);
}

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
  const preference = loadThemePreference(browserStore());
  applyTheme(document.documentElement, resolveTheme(preference, systemPrefersDark()));
}

/** Paints `theme` on the document root: the `.dark` class drives the CSS tokens. */
export function applyTheme(root: HTMLElement, theme: Theme): void {
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}
