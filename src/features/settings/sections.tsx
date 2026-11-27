import { isTauri } from "@tauri-apps/api/core";
import type { ComponentType } from "react";
import { ConnectionSection } from "./connection-section";
import { DiagnosticsSection } from "./diagnostics-section";
import { FilesSection } from "./files-section";
import { AppearanceSection, LanguageSection } from "./general-sections";
import { TerminalSection } from "./terminal-section";
import { TransfersSection } from "./transfers-section";
import { UpdatesSection } from "./updates-section";
import { WorkspaceSection } from "./workspace-section";

/** A group of related settings on the Settings page. */
export interface SettingsPageSection {
  id: string;
  /** i18n key of the section heading, under `settings.sections`. */
  title: "appearance" | "workspace" | "language" | "terminal" | "files" | "connection" | "transfers" | "updates" | "diagnostics";
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
  { id: "workspace", title: "workspace", Component: WorkspaceSection },
  { id: "terminal", title: "terminal", Component: TerminalSection },
  { id: "files", title: "files", Component: FilesSection },
  { id: "connection", title: "connection", Component: ConnectionSection },
  { id: "transfers", title: "transfers", Component: TransfersSection },
  { id: "language", title: "language", Component: LanguageSection },
  // These sections use native features of the installed app.
  ...(isTauri() ? [
    { id: "updates", title: "updates", Component: UpdatesSection },
    { id: "diagnostics", title: "diagnostics", Component: DiagnosticsSection },
  ] as const : []),
];
