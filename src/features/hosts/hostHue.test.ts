import { describe, expect, it } from "vitest";
import { hostHue, hostHues, monogram } from "./hostHue";

describe("hostHue", () => {
  it("gives the same hue for the same id every time", () => {
    expect(hostHue("3f2b8c1e-aaaa-4bbb-8ccc-000000000001")).toBe(hostHue("3f2b8c1e-aaaa-4bbb-8ccc-000000000001"));
  });

  it("always picks one of the six ANSI hues", () => {
    for (let i = 0; i < 200; i++) expect(hostHues).toContain(hostHue(`host-${i}`));
  });

  it("spreads ids over every hue", () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => hostHue(crypto.randomUUID() + i)));
    expect(seen.size).toBe(hostHues.length);
  });
});

describe("monogram", () => {
  it("takes the first letters of the first two words", () => {
    expect(monogram("web-01")).toBe("W0");
    expect(monogram("home assistant")).toBe("HA");
    expect(monogram("nas")).toBe("N");
  });

  it("falls back to a placeholder for a name with no letters", () => {
    expect(monogram("--")).toBe("?");
  });
});
