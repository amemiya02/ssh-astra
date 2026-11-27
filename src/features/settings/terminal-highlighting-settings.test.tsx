import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, expect, it, vi } from "vitest";
import { startI18n } from "@/i18n";
import { getSetting, setSetting } from "@/lib/storage";
import { terminalSetting } from "@/features/terminal/terminal-prefs";
import { TerminalSection } from "./terminal-section";

beforeAll(startI18n);

it("edits and removes a custom rule, keeping an invalid regex out of the saved pattern", () => {
  const original = getSetting(terminalSetting);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const clickButton = (label: string) =>
    act(() => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!.click());
  const saved = () => getSetting(terminalSetting).highlighting;

  try {
    act(() => root.render(<TerminalSection />));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Built-in rules"] [data-value="off"]')!.click());
    expect(saved().builtIn).toBe(false);
    clickButton("Add rule");
    const pattern = container.querySelector<HTMLInputElement>('[aria-label="Pattern"]')!;
    const type = container.querySelector<HTMLSelectElement>('[aria-label="Pattern type"]')!;
    const color = container.querySelector<HTMLSelectElement>('[aria-label="Highlight colour"]')!;
    const setPattern = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

    act(() => {
      type.value = "regex";
      type.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      setPattern.call(pattern, "[");
      pattern.dispatchEvent(new Event("input", { bubbles: true }));
      pattern.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Enter a valid regular expression.");
    expect(saved().rules[0]?.pattern).toBe("");

    act(() => {
      setPattern.call(pattern, "\\d+");
      pattern.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => pattern.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    act(() => {
      color.value = "magenta";
      color.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Enable rule"]')!.click());
    expect(saved().rules[0]).toMatchObject({ pattern: "\\d+", kind: "regex", hue: "magenta", enabled: false });

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove rule"]')!.click());
    expect(saved().rules).toEqual([]);
  } finally {
    act(() => root.unmount());
    container.remove();
    setSetting(terminalSetting, original);
    vi.unstubAllGlobals();
  }
});
