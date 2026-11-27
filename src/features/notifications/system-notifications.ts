import { isTauri } from "@tauri-apps/api/core";
import type { TFunction } from "i18next";
import i18n from "@/i18n";
import { showDesktopNotification, type NotificationText } from "@/lib/ipc/notifications";
import { getSetting } from "@/lib/storage";
import { shouldSendNotification } from "./notification-policy";
import { notificationSetting, type NotificationCategory } from "./notification-settings";

type NotificationSource =
  | { category: Exclude<NotificationCategory, "terminal"> }
  | { category: "terminal"; terminal: AbortSignal };

const lastTerminalMessage = new WeakMap<AbortSignal, number>();

/** Localized, best-effort desktop notifications. Callers also keep their in-app feedback. */
export function notifySystem(source: NotificationSource, message: (t: TFunction) => NotificationText): void {
  if (!isTauri()) return;

  const terminal = source.category === "terminal" ? source.terminal : undefined;
  if (terminal?.aborted) return;
  const now = performance.now();
  if (!shouldSendNotification({
    foreground: document.hasFocus(),
    enabled: getSetting(notificationSetting)[source.category],
    terminal: terminal && { now, lastSent: lastTerminalMessage.get(terminal) },
  })) return;

  if (terminal) lastTerminalMessage.set(terminal, now);
  void showDesktopNotification(message(i18n.t)).catch(() => undefined);
}
