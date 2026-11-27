import type { ITheme } from "@xterm/xterm";
import { appThemeList, type AppTheme, type AppThemeId } from "./themes";

/**
 * Named Terminal colour schemes the user can pick globally or per Host (to tell, say,
 * production apart at a glance): every app theme's Terminal palette under the theme's
 * id, plus `ember`. `app` is not listed: it means the painted app theme's own palette.
 * xterm parses hex, not oklch, so palettes live in `themes.ts` and here as literals.
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
/** A scheme choice: a named scheme, or `app` to follow the painted app theme. */
export type TerminalColorScheme = "app" | TerminalSchemeId;

export const terminalColorSchemes: readonly TerminalColorScheme[] = [
  "app",
  ...(Object.keys(terminalSchemes) as TerminalSchemeId[]),
];

export function isTerminalColorScheme(value: unknown): value is TerminalColorScheme {
  return typeof value === "string" && (terminalColorSchemes as readonly string[]).includes(value);
}

/**
 * The xterm palette to paint: the Host's own scheme when it has one, else the
 * global scheme; `app` is the Terminal palette of `appTheme`, the theme being painted.
 */
export function resolveTerminalTheme(
  global: TerminalColorScheme,
  hostOverride: TerminalColorScheme | null | undefined,
  appTheme: AppTheme,
): ITheme {
  const scheme = hostOverride ?? global;
  return scheme === "app" ? appTheme.terminal : terminalSchemes[scheme];
}
