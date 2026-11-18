import { defineSection } from "@/lib/storage";

/** The `updates` section of the settings file. Only the front end reads it. */
export interface UpdateSettings {
  /** Ask GitHub Releases for a newer version each time the app starts. */
  checkOnStartup: boolean;
}

export const defaultUpdateSettings: UpdateSettings = { checkOnStartup: true };

export const updateSetting = defineSection<UpdateSettings>("updates", defaultUpdateSettings, (raw) => {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).checkOnStartup : undefined;
  return { checkOnStartup: typeof value === "boolean" ? value : defaultUpdateSettings.checkOnStartup };
});
