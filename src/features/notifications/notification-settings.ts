import { defineSection } from "@/lib/storage";

export const notificationCategories = ["transfers", "reconnect", "longCommand", "terminal", "agentReview"] as const;
export type NotificationCategory = (typeof notificationCategories)[number];
type NotificationSettings = Record<NotificationCategory, boolean> & { longCommandThresholdSeconds: number };

const defaults: NotificationSettings = {
  transfers: true,
  reconnect: true,
  longCommand: true,
  longCommandThresholdSeconds: 10,
  terminal: true,
  agentReview: true,
};

export function isLongCommandThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export const notificationSetting = defineSection<NotificationSettings>("notifications", defaults, (raw) => {
  const saved = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const settings = { ...defaults };
  for (const category of notificationCategories) {
    const value = saved[category];
    if (typeof value === "boolean") settings[category] = value;
  }
  if (isLongCommandThreshold(saved.longCommandThresholdSeconds)) {
    settings.longCommandThresholdSeconds = saved.longCommandThresholdSeconds;
  }
  return settings;
});
