import type { ComponentType } from "react";
import { AppearanceSection, LanguageSection } from "./general-sections";

/** A group of related settings on the Settings page. */
export interface SettingsPageSection {
  id: string;
  /** i18n key of the section heading, under `settings.sections`. */
  title: "appearance" | "language";
  /** Renders the section's `SettingRow`s; reads and writes its settings with `useSetting`. */
  Component: ComponentType;
}

/**
 * The Settings page, top to bottom. To add settings: declare a section of the settings
 * file with `defineSection` next to the feature that uses it, write a component of
 * `SettingRow`s that edits it with `useSetting`, and add it here (a new heading needs a
 * key in `settings.sections` in both locales). Only list settings that work.
 */
export const settingsPageSections: readonly SettingsPageSection[] = [
  { id: "appearance", title: "appearance", Component: AppearanceSection },
  { id: "language", title: "language", Component: LanguageSection },
];
