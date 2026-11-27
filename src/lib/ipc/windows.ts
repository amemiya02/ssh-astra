import { invoke } from "@tauri-apps/api/core";
import type { HostId } from "./hosts";

/** Opens a separate Window with its own workspace. */
export function newWindow(): Promise<void> {
  return invoke("window_new");
}

/** Closes or hides this Window, or signals that the app would quit. */
export function tryCloseWindow(): Promise<boolean> {
  return invoke("window_try_close");
}

/** The one Window responsible for startup Hosts gets the layouts of all restored Windows. */
export function startupWorkspaces(): Promise<unknown[] | null> {
  return invoke("window_startup_workspaces");
}

export function quitApplication(): Promise<void> {
  return invoke("quit_application");
}

export function windowSettingsSaved(): Promise<void> {
  return invoke("window_settings_saved");
}

interface TrayLabels {
  showWindow: string;
  recentHosts: string;
  runningForwards: string;
  quit: string;
}

export function updateTray(labels: TrayLabels, recentHosts: HostId[]): Promise<void> {
  return invoke("tray_update", { labels, recentHosts });
}
