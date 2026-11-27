import { describe, expect, it } from "vitest";
import { appearanceSetting, applyTheme, resolveTheme, type AppearanceSettings } from "./theme";
import { appThemes } from "./themes";

const defaults: AppearanceSettings = { theme: "system", lightTheme: "light", darkTheme: "dark" };

describe("resolveTheme", () => {
  it("follows the system with the light or dark pick", () => {
    const settings = { ...defaults, lightTheme: "catppuccinLatte", darkTheme: "nord" } as const;
    expect(resolveTheme(settings, true).id).toBe("nord");
    expect(resolveTheme(settings, false).id).toBe("catppuccinLatte");
  });

  it("lets a fixed theme override the system", () => {
    expect(resolveTheme({ ...defaults, theme: "dracula" }, false).id).toBe("dracula");
    expect(resolveTheme({ ...defaults, theme: "light" }, true).id).toBe("light");
  });
});

describe("applyTheme", () => {
  it("marks dark themes and tells the browser which scheme native controls use", () => {
    const root = document.createElement("html");
    applyTheme(root, appThemes.nord);
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.style.colorScheme).toBe("dark");
    expect(root.dataset.theme).toBe("nord");

    applyTheme(root, appThemes.githubLight);
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.style.colorScheme).toBe("light");
    expect(root.dataset.theme).toBe("githubLight");
  });

  it("paints the chrome and the Terminal from the theme", () => {
    const root = document.createElement("html");
    applyTheme(root, appThemes.tokyoNight);
    const painted = (name: string) => root.style.getPropertyValue(name);
    expect(painted("--ui-ground")).toBe(appThemes.tokyoNight.ui.ground);
    expect(painted("--ui-muted-foreground")).toBe(appThemes.tokyoNight.ui.mutedForeground);
    expect(painted("--terminal-background")).toBe(appThemes.tokyoNight.terminal.background);
    expect(painted("--terminal-foreground")).toBe(appThemes.tokyoNight.terminal.foreground);
    expect(painted("--ansi-red")).toBe(appThemes.tokyoNight.terminal.red);
    expect(painted("--ansi-red-ink")).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("appearance settings", () => {
  it("keeps the values older versions saved", () => {
    expect(appearanceSetting.parse({ theme: "dark" })).toEqual({ ...defaults, theme: "dark" });
    expect(appearanceSetting.parse({ theme: "light" })).toEqual({ ...defaults, theme: "light" });
    expect(appearanceSetting.parse({ theme: "system" })).toEqual(defaults);
  });

  it("reads a saved theme and the system picks", () => {
    expect(appearanceSetting.parse({ theme: "nord", lightTheme: "githubLight", darkTheme: "dracula" })).toEqual({
      theme: "nord",
      lightTheme: "githubLight",
      darkTheme: "dracula",
    });
  });

  it("repairs nothing, junk and unknown values to the defaults", () => {
    for (const raw of [undefined, null, "dark", 3, { theme: "purple" }, { theme: 4, lightTheme: [], darkTheme: {} }]) {
      expect(appearanceSetting.parse(raw)).toEqual(defaults);
    }
  });

  it("refuses a dark theme as the light pick and the reverse", () => {
    expect(appearanceSetting.parse({ lightTheme: "nord", darkTheme: "githubLight" })).toEqual(defaults);
    expect(appearanceSetting.parse({ lightTheme: "dark", darkTheme: "light" })).toEqual(defaults);
  });
});
