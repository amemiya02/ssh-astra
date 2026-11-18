import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { getSetting, watchSetting } from "@/lib/storage";
import { generalSetting, languageFor } from "./language";
import { fallbackLanguage, resources } from "./resources";

const systemLanguages = () => navigator.languages ?? [navigator.language];

function show(language: string) {
  document.documentElement.lang = language;
  if (i18n.language !== language) void i18n.changeLanguage(language);
}

/**
 * Starts i18n in the saved language (call after settings have loaded) and switches the
 * whole UI live whenever the language setting changes.
 */
export function startI18n(): void {
  const lng = languageFor(getSetting(generalSetting).language, systemLanguages());
  void i18n.use(initReactI18next).init({
    resources,
    lng,
    fallbackLng: fallbackLanguage,
    interpolation: { escapeValue: false },
  });
  document.documentElement.lang = lng;
  watchSetting(generalSetting, ({ language }) => show(languageFor(language, systemLanguages())));
}

export default i18n;
