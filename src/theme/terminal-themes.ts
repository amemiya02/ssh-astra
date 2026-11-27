import type { ITheme } from "@xterm/xterm";
import { requiredPaletteKeys, type ItermPalette } from "./iterm-colors";
import { iterm2ColorSchemes } from "./iterm2-color-schemes";
import { appThemeList, type AppTheme, type AppThemeId } from "./themes";

/**
 * Named Terminal colour schemes the user can pick globally or per Host (to tell, say,
 * production apart at a glance): every app theme's Terminal palette under the theme's
 * id, Ember, and palettes from iTerm2-Color-Schemes.
 */
const themeSchemes = Object.fromEntries(appThemeList.map((theme) => [theme.id, theme.terminal])) as Record<
  AppThemeId,
  ITheme
>;

export const terminalSchemes = {
  ...themeSchemes,
  /** A deep red sheet, meant for production Hosts so they never pass for anything else. */
  ember: {
    background: "#2a1214",
    foreground: "#f0dcdc",
    cursor: "#f0dcdc",
    cursorAccent: "#2a1214",
    selectionBackground: "#ff8a9040",
    black: "#3d1c1f",
    red: "#ff6b6b",
    green: "#8fd694",
    yellow: "#f2c66d",
    blue: "#8fb4ff",
    magenta: "#e29ae6",
    cyan: "#7fd3dc",
    white: "#e6cfcf",
    brightBlack: "#8a6266",
    brightRed: "#ff8a8a",
    brightGreen: "#a8e6ac",
    brightYellow: "#f7d58f",
    brightBlue: "#a9c6ff",
    brightMagenta: "#ecb3ef",
    brightCyan: "#9fe0e7",
    brightWhite: "#fff2f2",
  },
  ...iterm2ColorSchemes,
} satisfies Record<string, ITheme>;

/** Search highlights in the Terminal: every match amber, the current one Astra Blue. Readable on every scheme. */
export const terminalSearchDecorations = {
  matchBackground: "#e0b45a59",
  matchBorder: "#e0b45a",
  matchOverviewRuler: "#e0b45a",
  activeMatchBackground: "#3b6fe080",
  activeMatchBorder: "#3b6fe0",
  activeMatchColorOverviewRuler: "#3b6fe0",
};

export type TerminalSchemeId = keyof typeof terminalSchemes;
type BuiltInTerminalScheme = "app" | TerminalSchemeId;
export type ImportedTerminalSchemeId = `imported:${string}`;
export type TerminalColorScheme = BuiltInTerminalScheme | ImportedTerminalSchemeId;

export interface ImportedTerminalScheme {
  id: ImportedTerminalSchemeId;
  name: string;
  palette: ItermPalette;
}

export const terminalColorSchemes: readonly BuiltInTerminalScheme[] = [
  "app",
  ...(Object.keys(terminalSchemes) as TerminalSchemeId[]),
];

export function isTerminalColorScheme(
  value: unknown,
  imported: readonly ImportedTerminalScheme[] = [],
): value is TerminalColorScheme {
  return typeof value === "string" && (
    (terminalColorSchemes as readonly string[]).includes(value) || imported.some(({ id }) => id === value)
  );
}

function colorHex(value: unknown, allowAlpha = false): value is string {
  const hex = allowAlpha ? /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i : /^#[0-9a-f]{6}$/i;
  return typeof value === "string" && hex.test(value);
}

export function terminalSchemeName(value: string): string {
  return Array.from(value.replace(/[\p{Cc}\p{Bidi_Control}]/gu, "").trim()).slice(0, 128).join("");
}

/** Keep valid imported choices from the settings file, including only xterm colour properties. */
export function normalizeImportedTerminalSchemes(value: unknown): ImportedTerminalScheme[] {
  if (!Array.isArray(value)) return [];
  const schemes = new Map<ImportedTerminalSchemeId, ImportedTerminalScheme>();
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, name, palette } = entry as Record<string, unknown>;
    if (
      typeof id !== "string" || !/^imported:[a-z0-9-]{1,60}$/i.test(id) ||
      typeof name !== "string" || typeof palette !== "object" || palette === null
    ) continue;
    const cleanName = terminalSchemeName(name);
    const schemeId = id as ImportedTerminalSchemeId;
    if (!cleanName || schemes.has(schemeId)) continue;
    const colors = palette as Record<string, unknown>;
    const required = requiredPaletteKeys.map((key) => [key, colors[key]] as const);
    if (required.some(([, color]) => !colorHex(color))) continue;
    const cleanPalette = Object.fromEntries(required) as ItermPalette;
    if (colorHex(colors.selectionBackground, true)) cleanPalette.selectionBackground = colors.selectionBackground;
    if (colorHex(colors.selectionForeground)) cleanPalette.selectionForeground = colors.selectionForeground;
    schemes.set(schemeId, { id: schemeId, name: cleanName, palette: cleanPalette });
  }
  return [...schemes.values()];
}

/**
 * The xterm palette to paint: the Host's own scheme when it has one, else the
 * global scheme; `app` is the Terminal palette of `appTheme`, the theme being painted.
 */
export function resolveTerminalTheme(
  global: TerminalColorScheme,
  hostOverride: string | null | undefined,
  appTheme: AppTheme,
  imported: readonly ImportedTerminalScheme[] = [],
): ITheme {
  const paletteFor = (scheme: string | null | undefined) => {
    if (scheme === "app") return appTheme.terminal;
    if (scheme && Object.hasOwn(terminalSchemes, scheme)) return terminalSchemes[scheme as TerminalSchemeId];
    return imported.find(({ id }) => id === scheme)?.palette;
  };
  return paletteFor(hostOverride) ?? paletteFor(global) ?? appTheme.terminal;
}
