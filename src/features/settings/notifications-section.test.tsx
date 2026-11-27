import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { startI18n } from "@/i18n";
import { startSettings } from "@/lib/storage";
import { NotificationsSection } from "./notifications-section";

it("offers a ten-second threshold for older settings and saves edits with the category preference", async () => {
  startI18n();
  const save = vi.fn().mockResolvedValue(undefined);
  await startSettings({
    load: async () => ({ notifications: { longCommand: false }, terminal: { shellIntegration: false } }),
    save,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);

  try {
    act(() => root.render(<NotificationsSection />));
    const input = container.querySelector<HTMLInputElement>('[aria-label="Long-command threshold (seconds)"]')!;
    expect(input.value).toBe("10");
    expect(container.textContent).toContain("Shell integration is off");

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const commit = (value: string) => {
      act(() => {
        input.focus();
        setValue.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    };

    commit("0");
    expect(input.value).toBe("10");
    expect(save).not.toHaveBeenCalled();

    commit("15");
    expect(input.value).toBe("15");
    expect(save).toHaveBeenCalledWith("notifications", {
      transfers: true,
      reconnect: true,
      longCommand: false,
      longCommandThresholdSeconds: 15,
      terminal: true,
    });
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
