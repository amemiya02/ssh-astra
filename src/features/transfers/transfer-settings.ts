import { defineSection } from "@/lib/storage";

/**
 * The `transfers` section of the settings file. The core applies `concurrency` as soon as
 * it is saved (`sshastra_core::files::TransferSettings`); lowering it lets running
 * transfers finish. `panelCollapsed` is the transfer panel's own UI state.
 */
export interface TransferSettings {
  /** How many transfers run at once; the rest wait in order. */
  concurrency: number;
  panelCollapsed: boolean;
}

export const maxConcurrency = 10;

export const defaultTransferSettings: TransferSettings = { concurrency: 3, panelCollapsed: false };

/** The choices on the Settings tab. */
export const concurrencyChoices = [1, 2, 3, 5, 8] as const;

export const transferSetting = defineSection<TransferSettings>("transfers", defaultTransferSettings, (raw) => {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const concurrency =
    typeof value.concurrency === "number" && Number.isFinite(value.concurrency)
      ? Math.min(maxConcurrency, Math.max(1, Math.round(value.concurrency)))
      : defaultTransferSettings.concurrency;
  return { concurrency, panelCollapsed: value.panelCollapsed === true };
});
