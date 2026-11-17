import { Channel, invoke } from "@tauri-apps/api/core";

/** Mirrors `sshastra_core::terminal::TerminalId`. */
export type TerminalId = number;

export interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * Where a remote Terminal stands after its Connection dropped (mirrors
 * `sshastra_core::terminal::ConnectionState`). `connected` means it is back, with a new shell.
 */
export type ConnectionState =
  | { state: "connected" }
  | { state: "reconnecting"; attempt: number; attempts: number }
  /** No more automatic tries; `reconnectTerminal` tries again. */
  | { state: "disconnected"; reason: string };

export type TerminalEvent =
  | { type: "output"; data: Uint8Array }
  /** Remote Terminals only. */
  | { type: "connection"; state: ConnectionState }
  | { type: "exit"; code: number | null };

/** Raw message shape on a Terminal's channel (see `src-tauri/src/commands/terminal.rs`). */
export type TerminalMessage = ArrayBuffer | number[] | { connection: ConnectionState } | { exitCode: number | null };

export function decodeTerminalMessage(message: TerminalMessage): TerminalEvent {
  if (message instanceof ArrayBuffer) return { type: "output", data: new Uint8Array(message) };
  if (Array.isArray(message)) return { type: "output", data: Uint8Array.from(message) };
  if ("connection" in message) return { type: "connection", state: message.connection };
  return { type: "exit", code: message.exitCode };
}

/**
 * Starts a Local terminal. Output is pushed to `onEvent` as soon as the shell
 * produces it; the last event is always `exit`.
 */
export async function openLocalTerminal(
  size: TerminalSize,
  onEvent: (event: TerminalEvent) => void,
): Promise<TerminalId> {
  const channel = new Channel<TerminalMessage>((message) => onEvent(decodeTerminalMessage(message)));
  return invoke<TerminalId>("local_terminal_open", { size, onEvent: channel });
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

export function closeTerminal(id: TerminalId): Promise<void> {
  return invoke("terminal_close", { id });
}
