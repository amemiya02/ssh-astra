import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, expect, it, vi } from "vitest";
import i18n, { startI18n } from "@/i18n";
import type { ConnectPrompt } from "@/lib/ipc/connect";
import { ConnectPromptDialog } from "./ConnectPromptDialog";

const prompt: ConnectPrompt = {
  type: "hostKey", id: 1, host: "example.com", port: 22,
  algorithm: "ssh-ed25519", fingerprint: "SHA256:test",
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  startI18n();
});

it.each([
  ["en", "Reject", "Trust for this run", "Save and trust"],
  ["zh", "拒绝", "仅本次运行信任", "保存并信任"],
])("submits each host key choice in %s", async (language, reject, trustForRun, saveAndTrust) => {
  await i18n.changeLanguage(language);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onAnswer = vi.fn();
  try {
    await act(async () => root.render(<ConnectPromptDialog prompt={prompt} open onAnswer={onAnswer} />));
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
    for (const label of [reject, trustForRun, saveAndTrust]) {
      const button = buttons.find((button) => button.textContent === label);
      expect(button?.textContent).toBe(label);
      act(() => button?.click());
    }
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onAnswer.mock.calls).toEqual([
      [{ type: "hostKey", decision: "reject" }],
      [{ type: "hostKey", decision: "trustForRun" }],
      [{ type: "hostKey", decision: "saveAndTrust" }],
      [{ type: "hostKey", decision: "reject" }],
    ]);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
