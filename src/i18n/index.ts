import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { resolveLanguage } from "./language";
import { fallbackLanguage, resources } from "./resources";

const lng = resolveLanguage(navigator.languages ?? [navigator.language]);

void i18n.use(initReactI18next).init({
  resources,
  lng,
  fallbackLng: fallbackLanguage,
  interpolation: { escapeValue: false },
});

document.documentElement.lang = lng;

export default i18n;
