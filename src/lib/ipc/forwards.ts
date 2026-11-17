import { Channel, invoke } from "@tauri-apps/api/core";
import { answerPrompts, type ConnectPrompt, type PromptAnswer } from "./connect";
import type { HostId } from "./hosts";

/** Mirrors `sshastra_core::forward::ForwardId`. */
export type ForwardId = string;

/**
 * What a Port forward tunnels (`sshastra_core::forward::ForwardKind`). Only
 * `local` exists so far; remote and dynamic forwards are further variants.
 */
export type ForwardKind = {
  type: "local";
  /** Where it listens on this machine; 127.0.0.1 unless the user chose otherwise. */
  bindAddress: string;
  bindPort: number;
  /** The address as the server sees it. */
  remoteHost: string;
  remotePort: number;
};

/** A rule's editable fields (`sshastra_core::forward::ForwardDraft`). */
export type ForwardDraft = { label: string } & ForwardKind;

/** A saved Port forward rule on a Host (`sshastra_core::forward::PortForward`). */
export type PortForward = { id: ForwardId } & ForwardDraft;

/** A rule's state (`sshastra_core::forward::ForwardStatus`). */
export type ForwardStatus = { state: "stopped" } | { state: "running" } | { state: "failed"; reason: string };

/** A rule's state changed (`sshastra_core::forward::ForwardEvent`). */
export interface ForwardEvent {
  hostId: HostId;
  forwardId: ForwardId;
  status: ForwardStatus;
}

/**
 * Sends every later state change to `onEvent` and resolves with the rules
 * running or failed now. One watcher at a time: a new call replaces the old.
 */
export function watchForwards(onEvent: (event: ForwardEvent) => void): Promise<ForwardEvent[]> {
  return invoke<ForwardEvent[]>("forwards_watch", { onEvent: new Channel<ForwardEvent>(onEvent) });
}

/** Adds a rule to a Host (no `id`), or replaces the rule with `id`. */
export function saveForward(hostId: HostId, draft: ForwardDraft, id?: ForwardId): Promise<PortForward> {
  return invoke<PortForward>("forward_save", { hostId, id: id ?? null, draft });
}

/** Stops and deletes a rule. */
export function deleteForward(hostId: HostId, id: ForwardId): Promise<void> {
  return invoke("forward_delete", { hostId, id });
}

/**
 * Starts a rule, connecting to its Host first if needed (`ask` answers the
 * connect's questions, as for a Terminal). Rejects with a `CommandError`, e.g.
 * `kind: "portInUse"`.
 */
export function startForward(
  hostId: HostId,
  id: ForwardId,
  ask: (prompt: ConnectPrompt) => Promise<PromptAnswer>,
): Promise<void> {
  const handle = answerPrompts(ask);
  const onPrompt = new Channel<ConnectPrompt>((prompt) => void handle(prompt));
  return invoke("forward_start", { hostId, id, onPrompt });
}

export function stopForward(id: ForwardId): Promise<void> {
  return invoke("forward_stop", { id });
}
