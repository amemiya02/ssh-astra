import { Channel, invoke } from "@tauri-apps/api/core";
import type { SshLinkTarget } from "./ssh-links";
import type { HostId } from "./hosts";
import { decodeTerminalMessage, type ConnectionState, type TerminalEvent, type TerminalMessage, type TerminalId, type TerminalSize } from "./terminal";

/** A question the backend asks while connecting (`src-tauri/src/prompts.rs`). */
export type ConnectPrompt =
  | { type: "hostKey"; id: number; host: string; port: number; algorithm: string; fingerprint: string }
  /** `canSave`: offer "save" (the system keychain works). */
  | { type: "password"; id: number; host: string; user: string; retry: boolean; canSave: boolean; proxy?: boolean }
  | { type: "passphrase"; id: number; keyPath: string; retry: boolean; canSave: boolean }
  | {
      type: "keyboardInteractive";
      id: number;
      host: string;
      user: string;
      /** Both may be empty. */
      name: string;
      instructions: string;
      /** Answer each, in order. `echo: false` means a secret. */
      prompts: { text: string; echo: boolean }[];
    };

/** A step reported by `sshastra_core::ssh::ConnectProgress`. */
export interface ConnectProgress {
  hostId: HostId;
  hostName: string;
  jumpHost: boolean;
  stage: "waiting" | "reused" | "reach" | "hostKey" | "authenticate" | "shell";
  status: "running" | "succeeded" | "failed";
  elapsedMs: number;
  method: "none" | "agent" | "keyFile" | "password" | "keyboardInteractive" | null;
}

type PromptMessage = ConnectPrompt
  | { type: "progress"; progress: ConnectProgress }
  | { type: "reconnect"; state: ConnectionState };

interface ConnectUpdates {
  onProgress(progress: ConnectProgress): void;
  onReconnect(state: ConnectionState): void;
}

/**
 * `null` means the user cancelled, which cancels the connect. `save` keeps the
 * password or passphrase in the system keychain once it proves right.
 */
export type PromptAnswer =
  | { type: "hostKey"; decision: "saveAndTrust" | "trustForRun" | "reject" }
  | { type: "password"; password: string | null; save?: boolean }
  | { type: "passphrase"; passphrase: string | null; save?: boolean }
  | { type: "keyboardInteractive"; answers: string[] | null };

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
  switch (prompt.type) {
    case "hostKey":
      return { type: "hostKey", decision: "reject" };
    case "password":
      return { type: "password", password: null };
    case "passphrase":
      return { type: "passphrase", passphrase: null };
    case "keyboardInteractive":
      return { type: "keyboardInteractive", answers: null };
  }
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

/** Progress and reconnect states share the ordered prompt Channel and expect no reply. */
export function connectPromptChannel(
  ask: (prompt: ConnectPrompt) => Promise<PromptAnswer>,
  updates?: ConnectUpdates,
): Channel<PromptMessage> {
  const handle = answerPrompts(ask);
  return new Channel<PromptMessage>((message) => {
    if (message.type === "progress") updates?.onProgress(message.progress);
    else if (message.type === "reconnect") updates?.onReconnect(message.state);
    else void handle(message);
  });
}

function sendPromptAnswer(id: number, answer: PromptAnswer): Promise<void> {
  return invoke("prompt_answer", { id, answer });
}

/**
 * Opens a Terminal on a saved Host, connecting first if needed. `ask` is
 * called for each question (host key, password, key passphrase,
 * keyboard-interactive). Rejects with a `CommandError`
 * (e.g. `kind: "hostKeyMismatch"`) when the connect fails.
 */
export async function openRemoteTerminal(
  hostId: HostId,
  size: TerminalSize,
  onEvent: (event: TerminalEvent) => void,
  ask: (prompt: ConnectPrompt) => Promise<PromptAnswer>,
  updates: ConnectUpdates,
  cwd?: string,
  expectedTarget?: SshLinkTarget,
): Promise<{ id: TerminalId; savedHost: boolean }> {
  const onPrompt = connectPromptChannel(ask, updates);
  const events = new Channel<TerminalMessage>((message) =>
    onEvent(decodeTerminalMessage(message)),
  );
  return invoke("remote_terminal_open", { hostId, size, onEvent: events, onPrompt, cwd, expectedTarget });
}
