import en from "./locales/en.json";
import zh from "./locales/zh.json";

/** All UI copy. English is the source of truth; every language must have the same keys. */
export const resources = {
  en: { translation: en },
  zh: { translation: zh },
} as const;

export type Language = keyof typeof resources;
export const fallbackLanguage: Language = "en";
