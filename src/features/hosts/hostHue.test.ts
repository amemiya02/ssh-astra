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
    expect(monogram("home assistant")).toBe("HA");
    expect(monogram("api-staging")).toBe("AS");
    expect(monogram("nas")).toBe("N");
  });

  it("keeps the number a name ends in, so siblings differ and no zero reads as an O", () => {
    expect(monogram("web-01")).toBe("W1");
    expect(monogram("web-02")).toBe("W2");
    expect(monogram("db-01")).toBe("D1");
    expect(monogram("db-12")).toBe("D12");
    expect(monogram("node.2024")).toBe("N24");
  });

  it("falls back to a placeholder for a name with no letters", () => {
    expect(monogram("--")).toBe("?");
  });
});
