import { Channel, invoke } from "@tauri-apps/api/core";
import type { HostId } from "./hosts";
import { decodeTerminalMessage, type TerminalEvent, type TerminalMessage, type TerminalId, type TerminalSize } from "./terminal";

/** A question the backend asks while connecting (`src-tauri/src/prompts.rs`). */
export type ConnectPrompt =
  | { type: "hostKey"; id: number; host: string; port: number; algorithm: string; fingerprint: string }
  | { type: "password"; id: number; host: string; user: string; retry: boolean };

export type PromptAnswer = { type: "hostKey"; trust: boolean } | { type: "password"; password: string | null };

/** The error shape every command rejects with (`src-tauri/src/error.rs`). */
export interface CommandError {
  kind: string;
  message: string;
  details?: Record<string, string | number>;
}

export function readCommandError(error: unknown): CommandError {
  if (typeof error === "object" && error !== null && "kind" in error && "message" in error) {
    return error as CommandError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "unknown", message };
}

/** What "no answer" means for each prompt: refuse, so the connect never hangs. */
export function refusal(prompt: ConnectPrompt): PromptAnswer {
  return prompt.type === "hostKey" ? { type: "hostKey", trust: false } : { type: "password", password: null };
}

/**
 * Turns a UI callback into a prompt-channel handler: asks the user, then sends
 * the answer back under the prompt's id. A failing callback counts as a refusal.
 */
export function answerPrompts(
  ask: (prompt: ConnectPrompt) => Promise<PromptAnswer>,
  answer: (id: number, answer: PromptAnswer) => Promise<void> = sendPromptAnswer,
): (prompt: ConnectPrompt) => Promise<void> {
  return async (prompt) => {
    let reply: PromptAnswer;
    try {
      reply = await ask(prompt);
    } catch {
      reply = refusal(prompt);
    }
    await answer(prompt.id, reply);
  };
}

function sendPromptAnswer(id: number, answer: PromptAnswer): Promise<void> {
  return invoke("prompt_answer", { id, answer });
}

/**
 * Opens a Terminal on a saved Host, connecting first if needed. `ask` is
 * called for host-key and password questions. Rejects with a `CommandError`
 * (e.g. `kind: "hostKeyMismatch"`) when the connect fails.
 */
export async function openRemoteTerminal(
  hostId: HostId,
  size: TerminalSize,
  onEvent: (event: TerminalEvent) => void,
  ask: (prompt: ConnectPrompt) => Promise<PromptAnswer>,
): Promise<TerminalId> {
  const handle = answerPrompts(ask);
  const onPrompt = new Channel<ConnectPrompt>((prompt) => void handle(prompt));
  const events = new Channel<TerminalMessage>((message) =>
    onEvent(decodeTerminalMessage(message)),
  );
  return invoke<TerminalId>("remote_terminal_open", { hostId, size, onEvent: events, onPrompt });
}
