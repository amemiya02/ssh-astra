import { invoke } from "@tauri-apps/api/core";

export interface KnownHostEntry {
  line: number;
  hosts: string;
  marker: "@cert-authority" | "@revoked" | null;
  algorithm: string;
  fingerprint: string;
  removalCommand: string | null;
}

export interface KnownHostsSnapshot {
  path: string | null;
  entries: KnownHostEntry[] | null;
  windows: boolean;
}

export function listKnownHosts(): Promise<KnownHostsSnapshot> {
  return invoke("known_hosts_list");
}

export function revealKnownHosts(): Promise<void> {
  return invoke("known_hosts_reveal");
}
