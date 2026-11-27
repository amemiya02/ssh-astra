import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { startI18n } from "@/i18n";
import { localStorageBackend, setSetting, startSettings } from "@/lib/storage";
import { notificationSetting } from "./notification-settings";
import { notifySystem } from "./system-notifications";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(async () => undefined),
}));

it("suppresses foreground and disabled notifications and keeps each Terminal's limit independent", async () => {
  await startSettings(localStorageBackend(undefined));
  startI18n();
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const clock = vi.spyOn(performance, "now").mockReturnValue(5_000);
  const first = new AbortController();
  const second = new AbortController();
  const request = (terminal: AbortSignal, body: string) => {
    notifySystem({ category: "terminal", terminal }, () => ({ title: "Terminal notification", body }));
  };

  try {
    request(first.signal, "Foreground");
    focus.mockReturnValue(false);
    setSetting(notificationSetting, { ...notificationSetting.defaults, terminal: false });
    request(first.signal, "Disabled");
    setSetting(notificationSetting, notificationSetting.defaults);
    request(first.signal, "First Terminal");
    request(first.signal, "Throttled");
    request(second.signal, "Second Terminal");
    clock.mockReturnValue(6_000);
    request(first.signal, "One second later");
    second.abort();
    request(second.signal, "Closed Terminal");

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["notification_show", { title: "Terminal notification", body: "First Terminal" }],
      ["notification_show", { title: "Terminal notification", body: "Second Terminal" }],
      ["notification_show", { title: "Terminal notification", body: "One second later" }],
    ]);
  } finally {
    focus.mockRestore();
    clock.mockRestore();
  }
});
