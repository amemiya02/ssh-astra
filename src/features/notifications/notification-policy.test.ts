import { expect, it } from "vitest";
import { shouldSendNotification } from "./notification-policy";

it("drops a notification while the app window is in front", () => {
  expect(shouldSendNotification({ foreground: true, enabled: true })).toBe(false);
  expect(shouldSendNotification({ foreground: false, enabled: true })).toBe(true);
});

it("drops a background notification when its category is disabled", () => {
  expect(shouldSendNotification({ foreground: false, enabled: false })).toBe(false);
});

it("limits each Terminal independently to one program notification per second", () => {
  const eligible = { foreground: false, enabled: true };
  expect(shouldSendNotification({ ...eligible, terminal: { now: 1100 } })).toBe(true);
  expect(shouldSendNotification({ ...eligible, terminal: { now: 1100, lastSent: 101 } })).toBe(false);
  expect(shouldSendNotification({ ...eligible, terminal: { now: 1100, lastSent: 100 } })).toBe(true);
});

it("only sends a command completion after it exceeds the configured duration in the background", () => {
  const background = { foreground: false, enabled: true };
  const command = { durationMs: 10_001, thresholdMs: 10_000 };
  expect(shouldSendNotification({ ...background, command: { ...command, durationMs: 9_999 } })).toBe(false);
  expect(shouldSendNotification({ ...background, command: { ...command, durationMs: 10_000 } })).toBe(false);
  expect(shouldSendNotification({ ...background, command })).toBe(true);
  expect(shouldSendNotification({ ...background, command: { ...command, thresholdMs: 20_000 } })).toBe(false);
  expect(shouldSendNotification({ foreground: true, enabled: true, command })).toBe(false);
  expect(shouldSendNotification({ foreground: false, enabled: false, command })).toBe(false);
});
