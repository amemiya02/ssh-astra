import { invoke } from "@tauri-apps/api/core";
import type { HostId } from "./hosts";

export function listCommandHistory(hostId: HostId): Promise<string[]> {
  return invoke("command_history_list", { hostId });
}

export function clearCommandHistory(hostId: HostId): Promise<void> {
  return invoke("command_history_clear", { hostId });
}
