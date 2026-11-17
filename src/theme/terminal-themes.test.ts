/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTerminalTheme, terminalSchemes, terminalThemes } from "./terminal-themes";

describe("resolveTerminalTheme", () => {
  it("follows the app theme when the scheme is app", () => {
    expect(resolveTerminalTheme("app", null, "dark").background).toBe("#131519");
    expect(resolveTerminalTheme("app", undefined, "light").background).toBe("#ffffff");
  });

  it("uses the global scheme whatever the app theme", () => {
    expect(resolveTerminalTheme("solarizedDark", null, "light").background).toBe("#002b36");
  });

  it("lets a Host's own scheme override the global one", () => {
    expect(resolveTerminalTheme("solarizedDark", "ember", "light").background).toBe("#2a1214");
    expect(resolveTerminalTheme("ember", "app", "dark").background).toBe("#131519");
  });
});

// Vitest stubs CSS imports, so read the stylesheet itself.
const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");

/** The value of `--name` inside the first CSS block that starts with `selector {`. */
function cssToken(selector: string, name: string): string | undefined {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf("}", start));
  return new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

describe("terminal themes", () => {
  it.each([
    ["light", ":root"],
    ["dark", ".dark"],
  ] as const)("paints the %s Terminal with the same colours as the CSS tokens", (theme, selector) => {
    expect(terminalThemes[theme].background).toBe(cssToken(selector, "terminal-background"));
    expect(terminalThemes[theme].foreground).toBe(cssToken(selector, "terminal-foreground"));
  });

  it("defines all 16 ANSI colours in every theme and scheme", () => {
    const ansi = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
    const keys = [...ansi, ...ansi.map((c) => `bright${c[0]?.toUpperCase()}${c.slice(1)}`)];
    for (const theme of [...Object.values(terminalThemes), ...Object.values(terminalSchemes)]) {
      for (const key of keys) expect(theme[key as keyof typeof theme], key).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
