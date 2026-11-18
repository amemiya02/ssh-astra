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

  it("words Port forward copy with the glossary: no Tunnel, and the Host is not the server", () => {
    // Only the sshd's own refusal (AllowTcpForwarding / GatewayPorts) really means the server.
    const sshdKeys = new Set(["forwards.startErrors.remoteRefused"]);
    const avoid = { en: /\btunnel|\bserver/i, zh: /隧道|服务器/ };
    for (const [lang, { translation }] of Object.entries(resources)) {
      const texts = (["forwards", "status"] as const).flatMap((section) =>
        leafKeys((translation as Record<string, unknown>)[section], section).map((key) => ({
          key,
          text: key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], translation),
        })),
      );
      const offending = texts
        .filter(({ key, text }) => !sshdKeys.has(key) && avoid[lang as "en" | "zh"].test(String(text)))
        .map(({ key }) => key);
      expect(offending, lang).toEqual([]);
    }
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
