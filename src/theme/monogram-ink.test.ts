import { describe, expect, it } from "vitest";
import { hueClasses } from "@/features/hosts/hostHue";
import { ansiHues, contrast, monogramInk, tileAlpha, tileBackings, tileFill } from "./monogram-ink";
import { appThemeList } from "./themes";

describe.each(appThemeList.map((theme) => [theme.name, theme] as const))("monogram tiles in %s", (_name, theme) => {
  it("reads at AA (4.5:1) on every tile, whatever the tile sits on", () => {
    for (const hue of ansiHues) {
      const ink = monogramInk(theme, hue);
      for (const backing of tileBackings(theme)) {
        expect.soft(contrast(ink, tileFill(theme, hue, backing)), `${hue} on ${backing}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("monogram tile classes", () => {
  it("tint at the alpha the ink is computed for and take their letters from the ink", () => {
    for (const hue of ansiHues) {
      expect(hueClasses[hue].tile).toBe(`bg-ansi-${hue}/${tileAlpha * 100} text-ansi-${hue}-ink`);
    }
  });
});
