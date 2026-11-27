import { invoke } from "@tauri-apps/api/core";

export interface NotificationText {
  title: string;
  body: string;
}

/** Posts an app-local notification if the native window is still in the background. */
export function showDesktopNotification(text: NotificationText): Promise<void> {
  return invoke("notification_show", { ...text });
}
