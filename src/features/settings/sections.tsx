import { isTauri } from "@tauri-apps/api/core";
import type { ComponentType } from "react";
import { AgentAccessSection } from "./agent-access-section";
import { ConnectionSection } from "./connection-section";
import { DiagnosticsSection } from "./diagnostics-section";
import { FilesSection } from "./files-section";
import { AppearanceCategory } from "./general-sections";
import { KnownHostsSection } from "./known-hosts-section";
import { NotificationsSection } from "./notifications-section";
import type { SettingsCategory } from "./setting-rows";
import { ShortcutsSection } from "./shortcuts-section";
import { TerminalSection } from "./terminal-section";
import { TransfersSection } from "./transfers-section";
import { UpdatesSection } from "./updates-section";

/** Register a category once its settings are available in the app. */
export const settingsPageSections: readonly { id: SettingsCategory; Component: ComponentType }[] = [
  { id: "appearance", Component: AppearanceCategory },
  { id: "terminal", Component: TerminalSection },
  { id: "files", Component: FilesSection },
  { id: "connection", Component: ConnectionSection },
  { id: "transfers", Component: TransfersSection },
  { id: "shortcuts", Component: ShortcutsSection },
  ...(isTauri() ? [
    { id: "knownHosts", Component: KnownHostsSection },
    { id: "notifications", Component: NotificationsSection },
    { id: "updates", Component: UpdatesSection },
    { id: "agentAccess", Component: AgentAccessSection },
    { id: "diagnostics", Component: DiagnosticsSection },
  ] as const : []),
];
