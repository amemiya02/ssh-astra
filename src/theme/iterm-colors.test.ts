import { describe, expect, it } from "vitest";
import sample from "./fixtures/sample.itermcolors?raw";
import binaryUrl from "./fixtures/sample-binary.itermcolors?url&inline";
import { maxItermColorsKiB, parseItermColors } from "./iterm-colors";
import { ansiColorKeys } from "./themes";

describe("parseItermColors", () => {
  it("accepts a binary property list written by Apple's plutil", () => {
    const bytes = Uint8Array.from(atob(binaryUrl.split(",")[1]!), (character) => character.charCodeAt(0));
    expect(parseItermColors(bytes)).toEqual(parseItermColors(sample));
    expect(parseItermColors(bytes.slice(0, -20))).toBeUndefined();
  });

  it("maps a plist sample to xterm colours in ANSI order", () => {
    const palette = parseItermColors(sample);
    expect(ansiColorKeys.map((key) => palette?.[key])).toEqual([
      "#000000", "#100804", "#201008", "#30180c",
      "#402010", "#502814", "#603018", "#70381c",
      "#804020", "#8f4824", "#9f5028", "#af582c",
      "#bf6030", "#cf6834", "#df7038", "#ef783c",
    ]);
    expect(palette).toMatchObject({
      background: "#004080",
      foreground: "#ffbf80",
      cursor: "#4080bf",
      cursorAccent: "#bf8040",
      selectionBackground: "#0080ff40",
      selectionForeground: "#ffffff",
    });
  });

  it.each(["-0.001", "1.001", "NaN", "Infinity", ""])("rejects %s as a required colour component", (value) => {
    expect(parseItermColors(sample.replace("<real>0.0</real>", `<real>${value}</real>`))).toBeUndefined();
  });

  it("requires all ANSI colours and bounds input size", () => {
    expect(parseItermColors(sample.replace("Ansi 15 Color", "Unused Color"))).toBeUndefined();
    expect(parseItermColors(sample.padEnd(maxItermColorsKiB * 1024 + 1))).toBeUndefined();
  });

  it("converts Display P3 to the sRGB colours xterm uses", () => {
    const p3 = sample.replaceAll("<string>sRGB</string>", "<string>P3</string>");
    // Reference result from the CSS Color 4 P3 → XYZ → sRGB matrices.
    expect(parseItermColors(p3)?.cursor).toBe("#2081c5");
  });
});
