import { defineSection, getSetting } from "@/lib/storage";
import {
  appThemes,
  darkThemeIds,
  isAppThemeId,
  lightThemeIds,
  type AppTheme,
  type AppThemeId,
  type DarkThemeId,
  type LightThemeId,
  type ThemeUi,
} from "./themes";

/** What the user asked for: follow the OS light/dark setting, or one fixed theme. */
export type ThemeChoice = "system" | AppThemeId;

export interface AppearanceSettings {
  theme: ThemeChoice;
  /** The theme painted while following the system and the OS is light. */
  lightTheme: LightThemeId;
  /** The theme painted while following the system and the OS is dark. */
  darkTheme: DarkThemeId;
}

const defaults: AppearanceSettings = { theme: "system", lightTheme: "light", darkTheme: "dark" };

function pick<T extends string>(ids: readonly T[], value: unknown, fallback: T): T {
  return ids.find((id) => id === value) ?? fallback;
}

/**
 * The `appearance` section of the settings file. `theme` kept its name and its old values
 * (`system`, `light`, `dark`), so files written before the theme gallery still load.
 */
export const appearanceSetting = defineSection<AppearanceSettings>("appearance", defaults, (raw) => {
  const stored = (raw ?? {}) as { theme?: unknown; lightTheme?: unknown; darkTheme?: unknown };
  return {
    theme: stored.theme === "system" || isAppThemeId(stored.theme) ? stored.theme : defaults.theme,
    lightTheme: pick(lightThemeIds, stored.lightTheme, defaults.lightTheme),
    darkTheme: pick(darkThemeIds, stored.darkTheme, defaults.darkTheme),
  };
});

/** The theme to paint for `settings`, given whether the OS is dark. */
export function resolveTheme(settings: AppearanceSettings, systemDark: boolean): AppTheme {
  if (settings.theme !== "system") return appThemes[settings.theme];
  return appThemes[systemDark ? settings.darkTheme : settings.lightTheme];
}

export const darkQuery = "(prefers-color-scheme: dark)";

export function systemPrefersDark(): boolean {
  return window.matchMedia(darkQuery).matches;
}

/** Applies the saved theme before React renders, so the first frame is already the right colour. */
export function applyInitialTheme(): void {
  applyTheme(document.documentElement, resolveTheme(getSetting(appearanceSetting), systemPrefersDark()));
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const ansiHues = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;

/**
 * Paints `theme` on the document root. The ui colours become `--ui-*` custom properties
 * that `src/index.css` derives every token from; the Terminal's colours become
 * `--terminal-*` and `--ansi-*`. `.dark` marks dark themes for the few styles that differ.
 */
export function applyTheme(root: HTMLElement, theme: AppTheme): void {
  for (const [name, value] of Object.entries(theme.ui) as [keyof ThemeUi, string][]) {
    root.style.setProperty(`--ui-${kebab(name)}`, value);
  }
  root.style.setProperty("--terminal-background", theme.terminal.background);
  root.style.setProperty("--terminal-foreground", theme.terminal.foreground);
  for (const hue of ansiHues) root.style.setProperty(`--ansi-${hue}`, theme.terminal[hue]);
  root.classList.toggle("dark", theme.appearance === "dark");
  root.style.colorScheme = theme.appearance;
  root.dataset.theme = theme.id;
}
