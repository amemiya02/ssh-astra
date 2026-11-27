import { describe, expect, it } from "vitest";
import { isTerminalColorScheme, resolveTerminalTheme, terminalSchemes } from "./terminal-themes";
import { appThemes } from "./themes";
import sample from "./fixtures/sample.itermcolors?raw";
import { parseItermColors } from "./iterm-colors";
import { iterm2ColorSchemes } from "./iterm2-color-schemes";
import { resources } from "@/i18n/resources";

describe("resolveTerminalTheme", () => {
  it("paints imported palettes globally and per Host, falling back when they are gone", () => {
    const palette = parseItermColors(sample)!;
    const id = "imported:example";
    const imported = [{ id, name: "Example", palette }] as const;
    expect(resolveTerminalTheme(id, null, appThemes.dark, imported)).toBe(palette);
    expect(resolveTerminalTheme("light", id, appThemes.dark, imported)).toBe(palette);
    expect(resolveTerminalTheme("light", id, appThemes.dark, [])).toBe(appThemes.light.terminal);
    expect(resolveTerminalTheme(id, null, appThemes.dark, [])).toBe(appThemes.dark.terminal);
  });

  it("paints the painted app theme's own Terminal when the scheme is app", () => {
    expect(resolveTerminalTheme("app", null, appThemes.nord)).toBe(appThemes.nord.terminal);
    expect(resolveTerminalTheme("app", undefined, appThemes.light).background).toBe(appThemes.light.terminal.background);
  });

  it("uses the global scheme whatever the app theme", () => {
    expect(resolveTerminalTheme("solarizedDark", null, appThemes.light).background).toBe("#002b36");
  });

  it("lets a Host's own scheme override the global one", () => {
    expect(resolveTerminalTheme("solarizedDark", "ember", appThemes.light).background).toBe("#2a1214");
    expect(resolveTerminalTheme("ember", "app", appThemes.dark)).toBe(appThemes.dark.terminal);
  });
});

describe("terminal schemes", () => {
  it("keeps every scheme id older versions could save", () => {
    for (const id of ["light", "dark", "solarizedLight", "solarizedDark", "nord", "ember"]) {
      expect(isTerminalColorScheme(id), id).toBe(true);
    }
    expect(isTerminalColorScheme("app")).toBe(true);
    expect(isTerminalColorScheme("purple")).toBe(false);
  });

  it("offers every app theme's Terminal under its id", () => {
    for (const theme of Object.values(appThemes)) expect(terminalSchemes[theme.id]).toBe(theme.terminal);
  });

  it("offers the 20 additional built-in palettes with names in both languages", () => {
    const extraIds = Object.keys(iterm2ColorSchemes);
    expect(extraIds).toHaveLength(20);
    for (const id of extraIds) {
      expect(isTerminalColorScheme(id), id).toBe(true);
      for (const { translation } of Object.values(resources)) {
        expect(translation.terminal.schemes, id).toHaveProperty(id, expect.stringMatching(/\S/));
      }
    }
  });
});
