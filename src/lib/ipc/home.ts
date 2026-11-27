import { invoke } from "@tauri-apps/api/core";

export function reportHomeFirstPaint(): Promise<void> {
  return invoke<void>("home_first_paint");
}
