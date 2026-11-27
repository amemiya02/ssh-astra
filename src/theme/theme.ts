import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { defineSection, getSetting } from "@/lib/storage";
import { ansiHues, monogramInk } from "./monogram-ink";
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
  /** Interface zoom as a percentage. */
  zoom: number;
  /** An empty name follows the system UI font. */
  fontFamily: string;
}

export const interfaceZoom = { min: 90, max: 125, step: 5 } as const;

const defaults: AppearanceSettings = { theme: "system", lightTheme: "light", darkTheme: "dark", zoom: 100, fontFamily: "" };

function pick<T extends string>(ids: readonly T[], value: unknown, fallback: T): T {
  return ids.find((id) => id === value) ?? fallback;
}

/**
 * The `appearance` section of the settings file. `theme` kept its name and its old values
 * (`system`, `light`, `dark`), so files written before the theme gallery still load.
 */
export const appearanceSetting = defineSection<AppearanceSettings>("appearance", defaults, (raw) => {
  const stored = (raw ?? {}) as { [Key in keyof AppearanceSettings]?: unknown };
  return {
    theme: stored.theme === "system" || isAppThemeId(stored.theme) ? stored.theme : defaults.theme,
    lightTheme: pick(lightThemeIds, stored.lightTheme, defaults.lightTheme),
    darkTheme: pick(darkThemeIds, stored.darkTheme, defaults.darkTheme),
    zoom: typeof stored.zoom === "number" && Number.isFinite(stored.zoom)
      ? Math.min(interfaceZoom.max, Math.max(interfaceZoom.min, stored.zoom))
      : defaults.zoom,
    fontFamily: typeof stored.fontFamily === "string" ? stored.fontFamily.replace(/[\n\r\f]/g, " ").trim() : defaults.fontFamily,
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

/** Applies the saved appearance before React renders. */
export async function applyInitialAppearance(): Promise<void> {
  const root = document.documentElement;
  const settings = getSetting(appearanceSetting);
  applyTheme(root, resolveTheme(settings, systemPrefersDark()));
  applyInterfaceFont(root, settings.fontFamily);
  await applyInterfaceZoom(root, settings.zoom);
}

export function applyInterfaceZoom(root: HTMLElement, zoom: number): Promise<void> | undefined {
  const scale = zoom / 100;
  root.style.setProperty("--interface-scale", String(scale));
  if (isTauri()) {
    // Page zoom keeps pointer coordinates and layout sizes in the same units for xterm and drag handles.
    return getCurrentWebview().setZoom(scale).catch((error: unknown) => {
      console.warn("Could not set interface zoom", error);
    });
  }
  root.dataset.browserZoom = "";
}

export function applyInterfaceFont(root: HTMLElement, fontFamily: string): void {
  if (fontFamily) {
    // Treat the preference as one named font, followed by the normal system stack.
    const name = fontFamily.replace(/["\\]/g, "\\$&");
    root.style.setProperty("--interface-font", `"${name}", var(--system-ui-font)`);
  } else {
    root.style.removeProperty("--interface-font");
  }
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * Paints `theme` on the document root. The ui colours become `--ui-*` custom properties
 * that `src/index.css` derives every token from; the Terminal's colours become
 * `--terminal-*` and `--ansi-*` (`--ansi-*-ink` is the hue as monogram letters). `.dark` marks dark themes for the few styles that differ.
 */
export function applyTheme(root: HTMLElement, theme: AppTheme): void {
  for (const [name, value] of Object.entries(theme.ui) as [keyof ThemeUi, string][]) {
    root.style.setProperty(`--ui-${kebab(name)}`, value);
  }
  root.style.setProperty("--terminal-background", theme.terminal.background);
  root.style.setProperty("--terminal-foreground", theme.terminal.foreground);
  for (const hue of ansiHues) {
    root.style.setProperty(`--ansi-${hue}`, theme.terminal[hue]);
    root.style.setProperty(`--ansi-${hue}-ink`, monogramInk(theme, hue));
  }
  root.classList.toggle("dark", theme.appearance === "dark");
  root.style.colorScheme = theme.appearance;
  root.dataset.theme = theme.id;
}
