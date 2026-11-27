import { defineSection, getSetting, setSetting } from "@/lib/storage";

export const privacyModeSetting = defineSection("privacyMode", false, (raw) => raw === true);

export function togglePrivacyMode(): void {
  setSetting(privacyModeSetting, !getSetting(privacyModeSetting));
}

export function workspaceHostName(
  host: { name: string; temporary?: boolean },
  t: (key: "quickConnect.temporaryHost") => string,
  privacyMode: boolean,
): string {
  return privacyMode && host.temporary ? t("quickConnect.temporaryHost") : host.name;
}
