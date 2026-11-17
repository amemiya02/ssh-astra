import { invoke } from "@tauri-apps/api/core";
import type { SettingsBackend } from "@/lib/storage";

/** The settings file (`sshastra_core::settings::SettingsStore`). Use it only through `lib/storage.ts`. */
export const tauriSettingsBackend: SettingsBackend = {
  load: () => invoke<Record<string, unknown>>("settings_load"),
  save: (section, value) => invoke("settings_set", { section, value }),
};
