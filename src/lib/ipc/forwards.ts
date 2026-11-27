import { Channel, invoke } from "@tauri-apps/api/core";
import { connectPromptChannel, type ConnectPrompt, type PromptAnswer } from "./connect";
import type { HostId } from "./hosts";

/** Mirrors `sshastra_core::forward::ForwardId`. */
export type ForwardId = string;

/**
 * What a Port forward tunnels (`sshastra_core::forward::ForwardKind`), tagged by `type` and stored
 * flat next to the rule's `id`, `label` and `autoStart`. The same shape is used by the hosts file
 * and Host list import/export; `ssh -L/-R/-D` map onto `local`/`remote`/`dynamic`.
 */
export type ForwardKind =
  | {
      /** `ssh -L`: listens here, carries each connection to `remoteHost:remotePort` as the server sees it. */
      type: "local";
      /** Where it listens on this machine; 127.0.0.1 unless the user chose otherwise. */
      bindAddress: string;
      bindPort: number;
      remoteHost: string;
      remotePort: number;
    }
  | {
      /** `ssh -R`: the server listens, each connection is carried to `localHost:localPort` from here. */
      type: "remote";
      /** Where the server listens; "localhost" (its loopback only) unless the user chose otherwise. */
      bindAddress: string;
      bindPort: number;
      localHost: string;
      localPort: number;
    }
  | {
      /** `ssh -D`: a SOCKS5 proxy here; the server opens each destination. */
      type: "dynamic";
      bindAddress: string;
      bindPort: number;
    };

export type ForwardType = ForwardKind["type"];

/** A rule's editable fields (`sshastra_core::forward::ForwardDraft`). */
export type ForwardDraft = {
  label: string;
  /** Start the rule whenever the Host connects. */
  autoStart: boolean;
} & ForwardKind;

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
  const onPrompt = connectPromptChannel(ask);
  return invoke("forward_start", { hostId, id, onPrompt });
}

export function stopForward(id: ForwardId): Promise<void> {
  return invoke("forward_stop", { id });
}
