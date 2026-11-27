import { isTauri } from "@tauri-apps/api/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { TooltipProvider } from "./components/ui/tooltip";
import { startI18n } from "./i18n";
import { watchFrontendErrors } from "./lib/ipc/diagnostics";
import { tauriSettingsBackend } from "./lib/ipc/settings";
import { browserStore, localStorageBackend, startSettings } from "./lib/storage";
import { applyInitialTheme } from "./theme/theme";
import { ThemeProvider } from "./theme/ThemeProvider";

async function start() {
  // In the app, settings live in the settings file and older builds' localStorage
  // preferences are moved into it; in a plain browser (`pnpm dev`) they stay in localStorage.
  if (isTauri()) await startSettings(tauriSettingsBackend, browserStore());
  else await startSettings(localStorageBackend(browserStore()));
  applyInitialTheme();
  startI18n();

  const root = document.getElementById("root");
  if (!root) throw new Error("#root element missing from index.html");

  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        <TooltipProvider delayDuration={500}>
          <App />
        </TooltipProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}

if (isTauri()) watchFrontendErrors();
void start();
