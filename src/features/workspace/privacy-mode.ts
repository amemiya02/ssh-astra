import { isTemporaryHost, type Host } from "@/lib/ipc/hosts";
import { defineSection, getSetting, setSetting } from "@/lib/storage";

export const privacyModeSetting = defineSection("privacyMode", false, (raw) => raw === true);

export function togglePrivacyMode(): void {
  setSetting(privacyModeSetting, !getSetting(privacyModeSetting));
}

export function workspaceHostName(
  host: Host,
  t: (key: "quickConnect.temporaryHost") => string,
  privacyMode: boolean,
): string {
  return privacyMode && isTemporaryHost(host) ? t("quickConnect.temporaryHost") : host.name;
}
