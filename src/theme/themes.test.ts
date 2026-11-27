import { describe, expect, it } from "vitest";
import { ansiColorKeys, appThemeList, appThemes, darkThemeIds, lightThemeIds } from "./themes";

/** WCAG relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const channel = (at: number) => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const hex = /^#[0-9a-f]{6}$/;

describe("app themes", () => {
  it("lists all 13 themes, light ones first, each listed under its own appearance", () => {
    expect(appThemeList).toHaveLength(13);
    expect(Object.keys(appThemes)).toHaveLength(13);
    for (const id of lightThemeIds) expect(appThemes[id].appearance).toBe("light");
    for (const id of darkThemeIds) expect(appThemes[id].appearance).toBe("dark");
    for (const [id, theme] of Object.entries(appThemes)) expect(theme.id).toBe(id);
  });

  describe.each(appThemeList.map((theme) => [theme.name, theme] as const))("%s", (_name, theme) => {
    it("defines all 16 ANSI colours and the Terminal's own colours as #rrggbb", () => {
      for (const key of ansiColorKeys) expect(theme.terminal[key], key).toMatch(hex);
      for (const key of ["background", "foreground", "cursor", "cursorAccent"] as const) {
        expect(theme.terminal[key], key).toMatch(hex);
      }
    });

    it("defines every ui colour as #rrggbb", () => {
      for (const [key, value] of Object.entries(theme.ui)) expect(value, key).toMatch(hex);
    });

    it("keeps text readable (WCAG AA, 4.5:1)", () => {
      const { ui, terminal } = theme;
      const pairs: [string, string, string][] = [
        ["foreground on ground", ui.foreground, ui.ground],
        ["foreground on surface", ui.foreground, ui.surface],
        ["foreground on raised", ui.foreground, ui.raised],
        ["mutedForeground on surface", ui.mutedForeground, ui.surface],
        ["mutedForeground on ground", ui.mutedForeground, ui.ground],
        ["primaryForeground on primary", ui.primaryForeground, ui.primary],
        ["terminal foreground on background", terminal.foreground, terminal.background],
      ];
      for (const [what, fg, bg] of pairs) expect.soft(contrast(fg, bg), what).toBeGreaterThanOrEqual(4.5);
    });
  });
});
