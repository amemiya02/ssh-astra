import { describe, expect, it } from "vitest";
import { resolveLanguage } from "./language";

describe("resolveLanguage", () => {
  it.each([
    [["zh-CN"], "zh"],
    [["zh-Hant-TW"], "zh"],
    [["en-US"], "en"],
    [["fr-FR", "zh-CN"], "zh"],
    [["fr-FR", "de"], "en"],
    [[], "en"],
  ])("system languages %j -> %s", (system, expected) => {
    expect(resolveLanguage(system)).toBe(expected);
  });
});
