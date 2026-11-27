import { resources } from "@/i18n/resources";
import type { SettingRowDefinition } from "./setting-rows";

function readMessage(locale: unknown, key: string): string {
  let value = locale;
  for (const part of key.split(".")) {
    if (!value || typeof value !== "object") return "";
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === "string" ? value.replace(/{{[^}]+}}/g, "") : "";
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** Match every term against a row's search copy in any supported language. */
export function filterSettingsRows(rows: readonly SettingRowDefinition[], query: string): readonly SettingRowDefinition[] {
  const normalized = normalize(query).trim();
  if (!normalized) return rows;

  const terms = normalized.split(/\s+/);
  return rows.filter(({ title, description, keywords }) => {
    const fields = [
      ...Object.values(keywords),
      ...Object.values(resources).flatMap(({ translation }) => [
        readMessage(translation, title),
        description ? readMessage(translation, description) : "",
      ]),
    ].map(normalize);

    return terms.every((term) => fields.some((field) => field.includes(term)));
  });
}
