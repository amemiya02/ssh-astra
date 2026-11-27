import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { QuickConnectTarget } from "./hosts";

export type SshLinkTarget = QuickConnectTarget & { user: string };

export function watchSshLinks(receive: (targets: SshLinkTarget[]) => void): () => void {
  let active = true;
  let reading = false;
  let pending = false;
  const drain = async () => {
    pending = true;
    if (reading || !active) return;
    reading = true;
    try {
      while (active && pending) {
        pending = false;
        const links = await invoke<SshLinkTarget[]>("take_ssh_links");
        if (active && links.length) receive(links);
      }
    } catch {
      if (active) console.warn("Could not read pending SSH links");
    } finally {
      reading = false;
    }
  };

  // Listen before draining: links that arrive during frontend startup stay in the native inbox.
  const subscription = getCurrentWebviewWindow().listen("ssh-link-pending", () => void drain());
  void subscription.then(drain, () => {
    if (active) console.warn("Could not listen for SSH links");
  });
  return () => {
    active = false;
    void subscription.then((unlisten) => unlisten(), () => undefined);
  };
}
