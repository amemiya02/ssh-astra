import { Channel, invoke } from "@tauri-apps/api/core";
import { connectPromptChannel, type ConnectPrompt, type PromptAnswer } from "./connect";
import type { HostDraft, HostId } from "./hosts";

/** A Host's Connection started or stopped being held by "Connect only" (`sshastra_core::ssh::HeldEvent`). */
export interface HeldEvent {
  hostId: HostId;
  held: boolean;
}

/**
 * Sends every later change to `onEvent` and resolves with the Hosts held connected now. One
 * watcher at a time: a new call replaces the old.
 */
export function watchConnections(onEvent: (event: HeldEvent) => void): Promise<HostId[]> {
  return invoke<HostId[]>("connections_watch", { onEvent: new Channel<HeldEvent>(onEvent) });
}

/**
 * "Connect only": connects to the Host (`ask` answers the connect's questions), starts its
 * auto-start Port forwards and keeps the Connection open with no Terminal.
 */
export function connectHost(hostId: HostId, ask: (prompt: ConnectPrompt) => Promise<PromptAnswer>): Promise<void> {
  const onPrompt = connectPromptChannel(ask);
  return invoke("host_connect", { hostId, onPrompt });
}

/** Authenticates using the Host editor's draft and closes the private Connection. */
export function testHostConnection(
  draft: HostDraft,
  id: HostId | undefined,
  ask: (prompt: ConnectPrompt) => Promise<PromptAnswer>,
): Promise<void> {
  const onPrompt = connectPromptChannel(ask);
  return invoke("host_test_connection", { id: id ?? null, draft, onPrompt });
}

/** Ends "Connect only": stops the Host's Port forwards and lets the Connection go. */
export function disconnectHost(hostId: HostId): Promise<void> {
  return invoke("host_disconnect", { hostId });
}
