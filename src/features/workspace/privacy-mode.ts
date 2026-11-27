import { defineSection, getSetting, setSetting } from "@/lib/storage";

export const privacyModeSetting = defineSection("privacyMode", false, (raw) => raw === true);

export function togglePrivacyMode(): void {
  setSetting(privacyModeSetting, !getSetting(privacyModeSetting));
}
