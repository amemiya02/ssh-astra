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
