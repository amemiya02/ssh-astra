import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { TransferHost } from "./transfers";

/** Mirrors `sshastra_core::terminal::TerminalId`. */
export type TerminalId = number;

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface LocalShell {
  id: string;
  label: string;
}

interface OpenedLocalTerminal {
  id: TerminalId;
  shellProgram: string;
  wslDistribution: string | null;
}

export function listLocalShells(): Promise<LocalShell[]> {
  return invoke("local_terminal_shells");
}

/**
 * Where a remote Terminal stands after its Connection dropped (mirrors
 * `sshastra_core::terminal::ConnectionState`). `connected` means it is back, with a new shell.
 */
export type ConnectionState =
  | { state: "connected" }
  | { state: "reconnecting"; attempt: number; attempts: number }
  /** No more automatic tries; `reconnectTerminal` tries again. */
  | { state: "disconnected"; reason: string; reportReconnectFailure: boolean };

export type ShellIntegrationStatus = "available" | "disabled" | "unsupported" | "timedOut";

export type ShellIntegrationEvent =
  | { type: "availability"; status: ShellIntegrationStatus }
  | { type: "promptStart"; promptId: number }
  | { type: "commandStart"; commandLine: string | null }
  | { type: "commandEnd"; exitCode: number };

export type TerminalOutputKind = "log" | "recording";

interface AgentScreenRequest {
  requestId: number;
  scrollbackLines: number;
}

export interface AgentScreenSnapshot {
  screen: string;
  scrollback: string;
  truncated: boolean;
}

export type TerminalOutputStatus =
  | { state: "active" }
  | { state: "stopped" }
  | { state: "failed"; message: string };

export type TerminalEvent =
  | { type: "output"; data: Uint8Array }
  /** Remote Terminals only. */
  | { type: "connection"; state: ConnectionState }
  /** The shell's current directory, from the local process or remote Shell integration. */
  | { type: "cwd"; path: string }
  | { type: "shellIntegration"; event: ShellIntegrationEvent }
  | { type: "terminalLog" | "recording"; status: TerminalOutputStatus }
  | { type: "agentScreen"; request: AgentScreenRequest }
  | { type: "localShellFallback" }
  | { type: "exit"; code: number | null };

/** Raw message shape on a Terminal's channel (see `src-tauri/src/commands/terminal.rs`). */
export type TerminalMessage =
  | ArrayBuffer
  | number[]
  | { connection: ConnectionState }
  | { cwd: string }
  | { shellIntegration: ShellIntegrationEvent }
  | { terminalLog: TerminalOutputStatus }
  | { recording: TerminalOutputStatus }
  | { agentScreen: AgentScreenRequest }
  | { localShellFallback: true }
  | { exitCode: number | null };

export function decodeTerminalMessage(message: TerminalMessage): TerminalEvent {
  if (message instanceof ArrayBuffer) return { type: "output", data: new Uint8Array(message) };
  if (Array.isArray(message)) return { type: "output", data: Uint8Array.from(message) };
  if ("connection" in message) return { type: "connection", state: message.connection };
  if ("cwd" in message) return { type: "cwd", path: message.cwd };
  if ("shellIntegration" in message) return { type: "shellIntegration", event: message.shellIntegration };
  if ("terminalLog" in message) return { type: "terminalLog", status: message.terminalLog };
  if ("recording" in message) return { type: "recording", status: message.recording };
  if ("agentScreen" in message) return { type: "agentScreen", request: message.agentScreen };
  if ("localShellFallback" in message) return { type: "localShellFallback" };
  return { type: "exit", code: message.exitCode };
}

/**
 * Starts a Local terminal. Output is pushed to `onEvent` as soon as the shell
 * produces it; the last event is always `exit`.
 */
export async function openLocalTerminal(
  size: TerminalSize,
  onEvent: (event: TerminalEvent) => void,
  cwd?: string,
  shellId?: string,
): Promise<OpenedLocalTerminal> {
  const channel = new Channel<TerminalMessage>((message) => onEvent(decodeTerminalMessage(message)));
  return invoke("local_terminal_open", { size, onEvent: channel, cwd, shellId });
}

/** Resolves file paths and the login shell within the selected WSL distribution. */
export function resolveWslPaths(distribution: string, paths: string[]): Promise<{ shellProgram: string; paths: string[] } | null> {
  return invoke("local_terminal_wsl_paths", { distribution, paths });
}

export function writeTerminal(id: TerminalId, data: string, generation?: number): Promise<void> {
  return invoke("terminal_write", { id, data, ...(generation !== undefined && { generation }) });
}

/** Changes directories on the same prompt the File panel observed, if it is still idle. */
export function followFileDirectory(id: TerminalId, promptId: number, path: string): Promise<void> {
  return invoke("terminal_follow_file_directory", { id, promptId, path });
}

export function resizeTerminal(id: TerminalId, size: TerminalSize): Promise<void> {
  return invoke("terminal_resize", { id, size });
}

/** Tries a remote Terminal's dropped Connection again now. */
export function reconnectTerminal(id: TerminalId): Promise<void> {
  return invoke("terminal_reconnect", { id });
}

/**
 * Makes a remote Terminal's shell report its directory once (a `cwd` event follows), by typing a
 * command into it: for shells ShellIntegration does not cover, or with it turned off.
 */
export function reportTerminalCwd(id: TerminalId): Promise<void> {
  return invoke("terminal_report_cwd", { id });
}

export function setTerminalTitle(id: TerminalId, title: string): Promise<void> {
  return invoke("terminal_set_title", { id, title });
}

export function answerAgentScreen(requestId: number, snapshot: AgentScreenSnapshot): Promise<void> {
  return invoke("terminal_agent_screen", { requestId, snapshot });
}

export function closeTerminal(id: TerminalId): Promise<void> {
  return invoke("terminal_close", { id });
}

export function setTerminalOutput(id: TerminalId, kind: TerminalOutputKind, action: "start" | "stop"): Promise<void> {
  return invoke(`terminal_${kind}_${action}`, { id });
}

export function pickTerminalOutputDirectory(title: string): Promise<string | null> {
  return open({ directory: true, multiple: false, title });
}

/** Saves an image-only clipboard and returns its local or uploaded PNG path. */
export function saveClipboardImage(
  id: TerminalId, target?: { host: TransferHost; generation: number },
): Promise<string | null> {
  return invoke("terminal_save_clipboard_image", { id, ...target });
}
