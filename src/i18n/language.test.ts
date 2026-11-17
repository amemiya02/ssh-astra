import { describe, expect, it } from "vitest";
import { generalSetting, languageFor, resolveLanguage } from "./language";

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

describe("languageFor", () => {
  it("uses the language the user picked over the system's", () => {
    expect(languageFor("zh", ["en-US"])).toBe("zh");
    expect(languageFor("en", ["zh-CN"])).toBe("en");
  });

  it("follows the system when the user picked system", () => {
    expect(languageFor("system", ["zh-CN"])).toBe("zh");
    expect(languageFor("system", ["fr"])).toBe("en");
  });
});

describe("general settings", () => {
  it("reads a saved interface language", () => {
    expect(generalSetting.parse({ language: "zh" })).toEqual({ language: "zh" });
    expect(generalSetting.parse({ language: "system" })).toEqual({ language: "system" });
  });

  it("follows the system when nothing or an unknown language is saved", () => {
    expect(generalSetting.parse(undefined)).toEqual({ language: "system" });
    expect(generalSetting.parse({ language: "fr" })).toEqual({ language: "system" });
    expect(generalSetting.parse(42)).toEqual({ language: "system" });
  });
});
