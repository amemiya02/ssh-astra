import { Channel, invoke } from "@tauri-apps/api/core";
import type { SettingsBackend, SettingsChange } from "@/lib/storage";

/** The settings file (`sshastra_core::settings::SettingsStore`). Use it only through `lib/storage.ts`. */
export const tauriSettingsBackend: SettingsBackend = {
  load: () => invoke<Record<string, unknown>>("settings_load"),
  watch: (receive) => invoke<Record<string, unknown>>("settings_load", { onChange: new Channel(receive) }),
  save: (section, value) => invoke<SettingsChange>("settings_set", { section, value }),
};
