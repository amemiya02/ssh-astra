import { Channel, invoke } from "@tauri-apps/api/core";
import type { connectPromptChannel } from "./connect";
import { decodeTerminalMessage, type TerminalEvent, type TerminalId, type TerminalMessage } from "./terminal";
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

/** The app-wide count of live SSH transports, including background transfers and other Windows. */
export function countLiveConnections(): Promise<number> {
  return invoke("quit_live_connection_count");
}

export function localizeQuitMenu(file: string, quit: string): Promise<void> {
  return invoke("quit_menu_localize", { file, quit });
}

interface MacosMenuItem {
  id: string;
  title: string;
  enabled: boolean;
  accelerator?: string;
}

interface MacosMenuSpec {
  labels: Record<string, string>;
  application: MacosMenuItem[];
  file: MacosMenuItem[];
  view: MacosMenuItem[];
  help: MacosMenuItem[];
}

export function setMacosMenu(spec: MacosMenuSpec): Promise<void> {
  return invoke("macos_menu_set", { spec });
}

export function prepareTabMove(token: string, terminals: TerminalId[], temporaryHosts: HostId[]): Promise<void> {
  return invoke("window_prepare_tab_move", { token, terminals, temporaryHosts });
}

export function openTabMove(token: string, payload: object): Promise<void> {
  return invoke("window_open_tab_move", { token, payload });
}

export function cancelTabMove(token: string): Promise<void> {
  return invoke("window_cancel_tab_move", { token });
}

export function readIncomingTabMove<T extends object>(): Promise<T | null> {
  return invoke("window_incoming_tab_move");
}

export function completeTabMove(): Promise<void> {
  return invoke("window_complete_tab_move");
}

export function stageMovedTerminal(
  id: TerminalId,
  onEvent: (event: TerminalEvent) => void,
  onPrompt?: ReturnType<typeof connectPromptChannel>,
): Promise<void> {
  const events = new Channel<TerminalMessage>((message) => onEvent(decodeTerminalMessage(message)));
  return invoke("window_stage_moved_terminal", { id, events, onPrompt });
}
