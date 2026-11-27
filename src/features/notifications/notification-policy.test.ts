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
