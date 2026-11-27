import { Channel, invoke } from "@tauri-apps/api/core";
import type { ResourceInterval } from "@/features/resources/resource-settings";
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

/** Streams a remote Terminal's resources until the subscription is stopped. */
export function watchResources(id: TerminalId, intervalSeconds: ResourceInterval, emit: (event: ResourceEvent) => void) {
  let active = true;
  const onEvent = new Channel<ResourceEvent>((event) => { if (active) emit(event); });
  const subscription = onEvent.id;
  const started = invoke<void>("terminal_resources_start", { id, onEvent, intervalSeconds });
  let updates = started.catch(() => { if (active) emit({ type: "unavailable" }); });
  return {
    setInterval(intervalSeconds: ResourceInterval) {
      // Register first and deliver changes in order, even when the user clicks quickly.
      updates = updates.then(() => {
        if (active) return invoke<void>("terminal_resources_set_interval", { id, subscription, intervalSeconds })
          .catch(() => undefined);
      });
    },
    stop() {
      active = false;
      void started.then(() => invoke("terminal_resources_stop", { id, subscription })).catch(() => undefined);
    },
  };
}
