import { defineSection } from "@/lib/storage";

export const resourceIntervals = [1, 2, 5] as const;
export type ResourceInterval = (typeof resourceIntervals)[number];

interface ResourceSettings {
  intervalSeconds: ResourceInterval;
}

const defaults: ResourceSettings = { intervalSeconds: 2 };

export const resourceSetting = defineSection("resources", defaults, (raw): ResourceSettings => {
  const value = typeof raw === "object" && raw !== null && "intervalSeconds" in raw
    ? raw.intervalSeconds : undefined;
  return { intervalSeconds: resourceIntervals.find((seconds) => seconds === value) ?? defaults.intervalSeconds };
});
