import { describe, expect, it } from "vitest";
import { ansiHues } from "@/theme/monogram-ink";
import { hostHue, monogram } from "./hostHue";

describe("hostHue", () => {
  const id = "3f2b8c1e-aaaa-4bbb-8ccc-000000000001";

  it("uses the Host's selected colour or keeps its automatic hue", () => {
    expect(hostHue({ id, color: "cyan" })).toBe("cyan");
    expect(hostHue({ id })).toBe("green");
  });

  it("always picks one of the six ANSI hues", () => {
    for (let i = 0; i < 200; i++) expect(ansiHues).toContain(hostHue({ id: `host-${i}` }));
  });

  it("spreads ids over every hue", () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => hostHue({ id: `host-${i}` })));
    expect(seen.size).toBe(ansiHues.length);
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
