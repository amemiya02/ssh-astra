import { describe, expect, it } from "vitest";
import { resources } from "./resources";

/** Every leaf key path in a nested resource object, e.g. `terminal.exited`. */
function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("i18n resources", () => {
  it("ships English and Chinese", () => {
    expect(Object.keys(resources).sort()).toEqual(["en", "zh"]);
  });

  it("has exactly the same keys in English and Chinese", () => {
    const en = leafKeys(resources.en.translation).sort();
    const zh = leafKeys(resources.zh.translation).sort();
    expect(zh).toEqual(en);
    expect(en.length).toBeGreaterThan(0);
  });

  it("has no empty strings", () => {
    for (const [lang, { translation }] of Object.entries(resources)) {
      for (const key of leafKeys(translation)) {
        const text = key.split(".").reduce<unknown>(
          (node, part) => (node as Record<string, unknown>)[part],
          translation,
        );
        expect(text, `${lang}:${key}`).toEqual(expect.stringMatching(/\S/));
      }
    }
  });
});
