import { Channel, invoke } from "@tauri-apps/api/core";

/** Mirrors `sshastra_core::terminal::TerminalId`. */
export type TerminalId = number;

export interface TerminalSize {
  cols: number;
  rows: number;
}

export type TerminalEvent =
  | { type: "output"; data: Uint8Array }
  | { type: "exit"; code: number | null };

/** Raw message shape on a Terminal's channel (see `src-tauri/src/commands/terminal.rs`). */
type TerminalMessage = ArrayBuffer | number[] | { exitCode: number | null };

export function decodeTerminalMessage(message: TerminalMessage): TerminalEvent {
  if (message instanceof ArrayBuffer) return { type: "output", data: new Uint8Array(message) };
  if (Array.isArray(message)) return { type: "output", data: Uint8Array.from(message) };
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

export function closeTerminal(id: TerminalId): Promise<void> {
  return invoke("terminal_close", { id });
}
