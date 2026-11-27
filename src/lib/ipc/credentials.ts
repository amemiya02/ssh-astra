import { invoke } from "@tauri-apps/api/core";
import type { HostId } from "./hosts";

/**
 * Forgets the credentials saved in the system keychain for a Host; its next connect asks again. Rejects with a `CommandError`
 * (`kind: "credentialStore"`) if the keychain refuses.
 */
export function clearHostCredentials(id: HostId): Promise<void> {
  return invoke("host_credentials_clear", { id });
}


export function clearGlobalProxyPassword(): Promise<void> {
  return invoke("global_proxy_password_clear");
}
