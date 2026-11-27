import { Channel, invoke } from "@tauri-apps/api/core";
import type { TerminalId } from "./terminal";

export interface ResourceUsage {
  used: number;
  total: number;
}

export interface ResourceSnapshot {
  cpuPercent: number | null;
  cores: number;
  load: [number, number, number];
  memory: ResourceUsage;
  swap: ResourceUsage;
  disks: (ResourceUsage & { mount: string })[];
  network: { name: string; receiveRate: number | null; sendRate: number | null }[];
  uptimeSeconds: number;
}

export type ResourceEvent = { type: "snapshot"; snapshot: ResourceSnapshot } | { type: "unsupported" | "unavailable" };

/** Streams the existing remote Terminal's resources until the returned cleanup runs. */
export function watchResources(id: TerminalId, emit: (event: ResourceEvent) => void): () => void {
  let active = true;
  const onEvent = new Channel<ResourceEvent>((event) => { if (active) emit(event); });
  const started = invoke<void>("terminal_resources_start", { id, onEvent });
  void started.catch(() => { if (active) emit({ type: "unavailable" }); });
  return () => {
    active = false;
    void started.then(() => invoke("terminal_resources_stop", { id, subscription: onEvent.id })).catch(() => undefined);
  };
}
