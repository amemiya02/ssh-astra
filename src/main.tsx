import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { TooltipProvider } from "./components/ui/tooltip";
import { hostsStore } from "./features/hosts/hostsStore";
import { restoreWorkspaceLayout, workspaceLayoutSetting } from "./features/workspace/workspace-layout";
import { workspaceSetting } from "./features/workspace/workspace-prefs";
import { startI18n } from "./i18n";
import { watchFrontendErrors } from "./lib/ipc/diagnostics";
import { tauriSettingsBackend } from "./lib/ipc/settings";
import { startupWorkspaces } from "./lib/ipc/windows";
import { browserStore, getSetting, localStorageBackend, startSettings } from "./lib/storage";
import { applyInitialAppearance } from "./theme/theme";
import { ThemeProvider } from "./theme/ThemeProvider";

async function start() {
  // In the app, settings live in the settings file and older builds' localStorage
  // preferences are moved into it; in a plain browser (`pnpm dev`) they stay in localStorage.
  if (isTauri()) await startSettings(tauriSettingsBackend, getCurrentWebviewWindow().label === "main" ? browserStore() : undefined);
  else await startSettings(localStorageBackend(browserStore()));
  await applyInitialAppearance();
  startI18n();

  // Resolve Host ids from the saved workspace only after the Host list is available.
  await hostsStore.getState().load();
  const { tree } = hostsStore.getState();
  const mode = getSetting(workspaceSetting).restoreTabs;
  const initialTabs = restoreWorkspaceLayout(getSetting(workspaceLayoutSetting), tree.hosts, mode);
  const rawWorkspaces = isTauri() ? await startupWorkspaces() : [];
  const startupTabsAcrossWindows = rawWorkspaces?.map((layout) =>
    restoreWorkspaceLayout(workspaceLayoutSetting.parse(layout), tree.hosts, mode)) ?? null;
  if (startupTabsAcrossWindows) startupTabsAcrossWindows.push(initialTabs);

  const root = document.getElementById("root");
  if (!root) throw new Error("#root element missing from index.html");

  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        <TooltipProvider delayDuration={500}>
          <App initialTabs={initialTabs} startupTabsAcrossWindows={startupTabsAcrossWindows} />
        </TooltipProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}

if (isTauri()) watchFrontendErrors();
void start();
