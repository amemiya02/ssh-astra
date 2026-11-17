import { defineSection } from "@/lib/storage";

/**
 * The `connection` section of the settings file. The core reads it
 * (`sshastra_core::ssh::ConnectionSettings`) whenever it opens a Connection, so a change
 * applies to Connections opened afterwards; open ones keep their interval.
 */
export interface ConnectionSettings {
  /** Seconds between keepalives on an idle Connection; 0 sends none. Three unanswered ones drop it. */
  keepaliveSeconds: number;
}

export const maxKeepaliveSeconds = 3600;

export const defaultConnectionSettings: ConnectionSettings = { keepaliveSeconds: 30 };

/** The choices on the Settings tab. */
export const keepaliveChoices = [0, 15, 30, 60, 120, 300] as const;

export const connectionSetting = defineSection<ConnectionSettings>("connection", defaultConnectionSettings, (raw) => {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).keepaliveSeconds : undefined;
  const keepaliveSeconds =
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.min(maxKeepaliveSeconds, Math.round(value))
      : defaultConnectionSettings.keepaliveSeconds;
  return { keepaliveSeconds };
});
