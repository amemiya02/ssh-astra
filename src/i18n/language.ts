import { defineSection } from "@/lib/storage";
import { fallbackLanguage, resources, type Language } from "./resources";

/** The interface language the user picked; `system` follows the OS. */
export type LanguagePreference = "system" | Language;

export const languagePreferences: readonly LanguagePreference[] = [
  "system",
  ...(Object.keys(resources) as Language[]),
];

export interface GeneralSettings {
  language: LanguagePreference;
}

/** The `general` section of the settings file. */
export const generalSetting = defineSection<GeneralSettings>("general", { language: "system" }, (raw) => {
  const language = (raw as { language?: unknown } | null)?.language;
  return { language: languagePreferences.find((l) => l === language) ?? "system" };
});

/**
 * Picks the UI language from the system's preferred languages (BCP 47 tags, most
 * preferred first): the first one we ship wins, otherwise English.
 */
export function resolveLanguage(systemLanguages: readonly string[]): Language {
  for (const tag of systemLanguages) {
    const normalized = tag.toLowerCase();
    // An explicit script comes before the region, so zh-Hans-HK stays Simplified.
    if (/^zh-(?:hant|tw|hk|mo)(?:-|$)/.test(normalized)) return "zh-Hant";
    const base = normalized.split("-")[0];
    if (base && Object.hasOwn(resources, base)) return base as Language;
  }
  return fallbackLanguage;
}

/** The language to show for a preference. */
export function languageFor(preference: LanguagePreference, systemLanguages: readonly string[]): Language {
  return preference === "system" ? resolveLanguage(systemLanguages) : preference;
}
