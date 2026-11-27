import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

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
  | { type: "promptStart" }
  | { type: "commandStart"; commandLine: string | null }
  | { type: "commandEnd"; exitCode: number };

export type TerminalOutputKind = "log" | "recording";

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
): Promise<TerminalId> {
  const channel = new Channel<TerminalMessage>((message) => onEvent(decodeTerminalMessage(message)));
  return invoke<TerminalId>("local_terminal_open", { size, onEvent: channel, cwd, shellId });
}

export function writeTerminal(id: TerminalId, data: string): Promise<void> {
  return invoke("terminal_write", { id, data });
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

export function closeTerminal(id: TerminalId): Promise<void> {
  return invoke("terminal_close", { id });
}

export function setTerminalOutput(id: TerminalId, kind: TerminalOutputKind, action: "start" | "stop"): Promise<void> {
  return invoke(`terminal_${kind}_${action}`, { id });
}

export function pickTerminalOutputDirectory(title: string): Promise<string | null> {
  return open({ directory: true, multiple: false, title });
}
