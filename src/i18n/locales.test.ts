import { describe, expect, it } from "vitest";
import { resources, type Language } from "./resources";

/** Every leaf message by its nested resource key. */
function messages(value: unknown, prefix = ""): [string, unknown][] {
  if (typeof value !== "object" || value === null) return [[prefix, value]];
  return Object.entries(value).flatMap(([key, child]) =>
    messages(child, prefix ? `${prefix}.${key}` : key),
  );
}

function placeholders(text: unknown): string[] {
  return Array.from(String(text).matchAll(/{{[^}]+}}/g), ([placeholder]) => placeholder).sort();
}

describe("i18n resources", () => {
  it("ships English, Simplified Chinese, and Traditional Chinese", () => {
    expect(Object.keys(resources).sort()).toEqual(["en", "zh", "zh-Hant"]);
  });

  it("has the same keys and interpolation placeholders in every language", () => {
    const { en, ...localized } = resources;
    const english = Object.fromEntries(messages(en.translation));
    const keys = Object.keys(english).sort();
    expect(keys.length).toBeGreaterThan(0);

    for (const [lang, { translation }] of Object.entries(localized)) {
      const localizedMessages = Object.fromEntries(messages(translation));
      expect(Object.keys(localizedMessages).sort(), lang).toEqual(keys);
      for (const key of keys) {
        expect(placeholders(localizedMessages[key]), `${lang}:${key}`).toEqual(placeholders(english[key]));
      }
    }
  });

  it("words Port forward copy with the glossary: no Tunnel, and the Host is not the server", () => {
    // Only the sshd's own refusal (AllowTcpForwarding / GatewayPorts) really means the server.
    const sshdKeys = new Set(["forwards.startErrors.remoteRefused"]);
    const avoid: Record<Language, RegExp> = {
      en: /\btunnel|\bserver/i,
      zh: /隧道|服务器/,
      "zh-Hant": /隧道|伺服器/,
    };
    for (const [lang, { translation }] of Object.entries(resources)) {
      const texts = (["forwards", "status"] as const).flatMap((section) => messages(translation[section], section));
      const offending = texts
        .filter(([key, text]) => !sshdKeys.has(key) && avoid[lang as Language].test(String(text)))
        .map(([key]) => key);
      expect(offending, lang).toEqual([]);
    }
  });

  it("has no empty strings", () => {
    for (const [lang, { translation }] of Object.entries(resources)) {
      for (const [key, text] of messages(translation)) {
        expect(text, `${lang}:${key}`).toEqual(expect.stringMatching(/\S/));
      }
    }
  });
});
