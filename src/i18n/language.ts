import { fallbackLanguage, resources, type Language } from "./resources";

/**
 * Picks the UI language from the system's preferred languages (BCP 47 tags, most
 * preferred first): the first one we ship wins, otherwise English.
 */
export function resolveLanguage(systemLanguages: readonly string[]): Language {
  for (const tag of systemLanguages) {
    const base = tag.toLowerCase().split("-")[0];
    if (base && base in resources) return base as Language;
  }
  return fallbackLanguage;
}
