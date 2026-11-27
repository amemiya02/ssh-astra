import { describe, expect, it } from "vitest";
import {
  builtInHighlightRules,
  compileHighlightRules,
  matchHighlightLines,
  type HighlightRule,
} from "./terminal-highlighting";

function find(text: string, ...rules: HighlightRule[]) {
  return matchHighlightLines([text], compileHighlightRules(rules))[0];
}

describe("Terminal keyword highlighting", () => {
  it("finds plain text case-insensitively and treats punctuation literally", () => {
    expect(find("[OK] ok", { pattern: "[ok]", kind: "text", hue: "cyan", enabled: true })).toEqual([
      { start: 0, end: 4, hue: "cyan" },
    ]);
  });

  it("finds regular expression matches and skips disabled, invalid and zero-width rules", () => {
    expect(find("job 12 failed",
      { pattern: "\\d+", kind: "regex", hue: "yellow", enabled: true },
      { pattern: "^", kind: "regex", hue: "green", enabled: true },
      { pattern: "[", kind: "regex", hue: "magenta", enabled: true },
      { pattern: "failed", kind: "text", hue: "red", enabled: false },
    )).toEqual([{ start: 4, end: 6, hue: "yellow" }]);
  });

  it("lets the later rule win where two ranges overlap", () => {
    expect(find("warning",
      { pattern: "warning", kind: "text", hue: "yellow", enabled: true },
      { pattern: "^war", kind: "regex", hue: "red", enabled: true },
    )).toEqual([
      { start: 0, end: 3, hue: "red" },
      { start: 3, end: 7, hue: "yellow" },
    ]);
  });

  it("matches lines of 1,000 characters and skips an entire longer line", () => {
    const rule = { pattern: "x", kind: "text", hue: "blue", enabled: true } as const;
    expect(find("😀".repeat(999) + "x", rule)).toEqual([{ start: 1998, end: 1999, hue: "blue" }]);
    expect(find("x" + "😀".repeat(1000), rule)).toEqual([]);
  });

  it("recognizes built-in log words and valid IPv4 octets", () => {
    expect(find("ERROR warning Failed Success 192.168.0.1 256.1.1.1", ...builtInHighlightRules)).toEqual([
      { start: 0, end: 5, hue: "red" },
      { start: 6, end: 13, hue: "yellow" },
      { start: 14, end: 20, hue: "red" },
      { start: 21, end: 28, hue: "green" },
      { start: 29, end: 40, hue: "cyan" },
    ]);
  });
});
