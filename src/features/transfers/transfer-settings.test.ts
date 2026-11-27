import { describe, expect, it } from "vitest";
import { transferSetting } from "./transfer-settings";

describe("transfers settings section", () => {
  it("runs three transfers at once with the panel open by default", () => {
    expect(transferSetting.parse(undefined)).toEqual({ concurrency: 3, panelCollapsed: false, preventSleep: true });
  });

  it("prevents idle sleep with older settings and keeps an explicit opt-out", () => {
    expect(transferSetting.parse({ concurrency: 5 }).preventSleep).toBe(true);
    expect(transferSetting.parse({ preventSleep: false }).preventSleep).toBe(false);
  });

  it("keeps the concurrency a whole number from 1 to 10", () => {
    expect(transferSetting.parse({ concurrency: 0 }).concurrency).toBe(1);
    expect(transferSetting.parse({ concurrency: 99 }).concurrency).toBe(10);
    expect(transferSetting.parse({ concurrency: 4.6 }).concurrency).toBe(5);
    expect(transferSetting.parse({ concurrency: "8" }).concurrency).toBe(3);
  });

  it("keeps a collapsed panel collapsed", () => {
    expect(transferSetting.parse({ panelCollapsed: true }).panelCollapsed).toBe(true);
  });
});
