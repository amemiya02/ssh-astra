import type { ITheme } from "@xterm/xterm";
import type { Theme } from "./theme";

/**
 * xterm.js palettes for the app's light and dark themes (see DESIGN.md, Terminal).
 * xterm parses hex, not oklch, so these are the one place colours are literal.
 * Background and foreground must match `--terminal-*` in src/index.css.
 */
export const terminalThemes: Record<Theme, ITheme> = {
  light: {
    background: "#ffffff",
    foreground: "#2b2f37",
    cursor: "#2b2f37",
    cursorAccent: "#ffffff",
    selectionBackground: "#2f5fd033",
    black: "#2b2f37",
    red: "#c4372f",
    green: "#1f8a4c",
    yellow: "#946200",
    blue: "#2f5fd0",
    magenta: "#a33ea1",
    cyan: "#12808f",
    white: "#6b7280",
    brightBlack: "#8a8f99",
    brightRed: "#d6453c",
    brightGreen: "#239a55",
    brightYellow: "#a87300",
    brightBlue: "#3b6fe0",
    brightMagenta: "#b54ab3",
    brightCyan: "#168a9a",
    brightWhite: "#9aa0aa",
  },
  dark: {
    background: "#131519",
    foreground: "#d9dce3",
    cursor: "#d9dce3",
    cursorAccent: "#131519",
    selectionBackground: "#7aa2f740",
    black: "#2a2e36",
    red: "#f07178",
    green: "#6fcf8f",
    yellow: "#e0b45a",
    blue: "#7aa2f7",
    magenta: "#d08bd8",
    cyan: "#66c7d4",
    white: "#c9ccd3",
    brightBlack: "#6b7280",
    brightRed: "#ff8a90",
    brightGreen: "#8ae0a6",
    brightYellow: "#f0c674",
    brightBlue: "#9bbcff",
    brightMagenta: "#e0a6e6",
    brightCyan: "#8ad8e2",
    brightWhite: "#f2f4f8",
  },
};

/**
 * Named Terminal colour schemes the user can pick globally or per Host (to
 * tell, say, production apart at a glance). `app` is not listed: it means
 * "follow the app's light/dark theme" and resolves to `terminalThemes`.
 */
export const terminalSchemes = {
  light: terminalThemes.light,
  dark: terminalThemes.dark,
  solarizedLight: {
    background: "#fdf6e3",
    foreground: "#586e75",
    cursor: "#586e75",
    cursorAccent: "#fdf6e3",
    selectionBackground: "#268bd233",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#002b36",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  solarizedDark: {
    background: "#002b36",
    foreground: "#93a1a1",
    cursor: "#93a1a1",
    cursorAccent: "#002b36",
    selectionBackground: "#268bd240",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#586e75",
    brightRed: "#cb4b16",
    brightGreen: "#859900",
    brightYellow: "#b58900",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  nord: {
    background: "#2e3440",
    foreground: "#d8dee9",
    cursor: "#d8dee9",
    cursorAccent: "#2e3440",
    selectionBackground: "#88c0d040",
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
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
/** A scheme choice: a named scheme, or `app` to follow the app's light/dark theme. */
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
 * global scheme; `app` follows the app's light/dark theme.
 */
export function resolveTerminalTheme(
  global: TerminalColorScheme,
  hostOverride: TerminalColorScheme | null | undefined,
  appTheme: Theme,
): ITheme {
  const scheme = hostOverride ?? global;
  return scheme === "app" ? terminalThemes[appTheme] : terminalSchemes[scheme];
}
