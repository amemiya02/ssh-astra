import { isTauri } from "@tauri-apps/api/core";
import type { ComponentType } from "react";
import { ConnectionSection } from "./connection-section";
import { DiagnosticsSection } from "./diagnostics-section";
import { FilesSection } from "./files-section";
import { AppearanceSection, LanguageSection } from "./general-sections";
import type { SettingsCategory } from "./setting-rows";
import { TerminalSection } from "./terminal-section";
import { TransfersSection } from "./transfers-section";
import { UpdatesSection } from "./updates-section";
import { WorkspaceSection } from "./workspace-section";

function AppearanceCategory() {
  return (
    <>
      <AppearanceSection />
      <WorkspaceSection />
      <LanguageSection />
    </>
  );
}

/** Register a category once its settings are available in the app. */
export const settingsPageSections: readonly { id: SettingsCategory; Component: ComponentType }[] = [
  { id: "appearance", Component: AppearanceCategory },
  { id: "terminal", Component: TerminalSection },
  { id: "files", Component: FilesSection },
  { id: "connection", Component: ConnectionSection },
  { id: "transfers", Component: TransfersSection },
  ...(isTauri() ? [
    { id: "updates", Component: UpdatesSection },
    { id: "diagnostics", Component: DiagnosticsSection },
  ] as const : []),
];
