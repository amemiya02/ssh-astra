import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { startI18n } from "@/i18n";
import { startSettings } from "@/lib/storage";
import { ConnectionSection } from "./connection-section";

it("saves and clears the custom agent path alongside the existing keepalive setting", async () => {
  startI18n();
  const save = vi.fn().mockResolvedValue(undefined);
  await startSettings({ load: async () => ({ connection: { keepaliveSeconds: 60 } }), save });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);

  try {
    act(() => root.render(<ConnectionSection />));
    const input = container.querySelector<HTMLInputElement>('[aria-label="Custom agent path"]')!;
    expect(input.value).toBe("");

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const type = (value: string) => act(() => {
      input.focus();
      setValue.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const path = "~/Library/Group Containers/agent.sock";
    type(path);
    expect(save).not.toHaveBeenCalled();
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(save).toHaveBeenLastCalledWith("connection", { keepaliveSeconds: 60, agentPath: path });

    type("");
    act(() => input.blur());
    expect(save).toHaveBeenLastCalledWith("connection", { keepaliveSeconds: 60, agentPath: "" });
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
