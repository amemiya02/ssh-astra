import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import i18n, { startI18n } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { terminalSetting } from "@/features/terminal/terminal-prefs";
import { getSetting, setSetting } from "@/lib/storage";
import sample from "@/theme/fixtures/sample.itermcolors?raw";
import { TerminalSection } from "./terminal-section";

it("imports a selected palette, lets the user pick it, and falls back after removal", async () => {
  startI18n();
  await i18n.changeLanguage("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const original = getSetting(terminalSetting);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const picker = () => container.querySelector<HTMLButtonElement>('button[aria-label="Colour scheme"]')!;

  try {
    act(() => root.render(<TooltipProvider><TerminalSection /></TooltipProvider>));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const button = [...container.querySelectorAll("button")].find((button) => button.textContent === "Import .itermcolors")!;
    const openFilePicker = vi.spyOn(input, "click");
    act(() => button.click());
    expect(openFilePicker).toHaveBeenCalledOnce();

    const bytes = new TextEncoder().encode(sample);
    const file = { name: "Example.itermcolors", size: bytes.length, arrayBuffer: () => Promise.resolve(bytes.buffer) };
    Object.defineProperty(input, "files", { value: [file] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Colour scheme imported.");
    expect(picker().textContent).toBe("Match app theme");

    await act(async () => { picker().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((item) => item.textContent === "Example")!;
    act(() => option.click());
    expect(picker().textContent).toBe("Example");
    expect(getSetting(terminalSetting).colorScheme).toBe(getSetting(terminalSetting).importedSchemes[0]?.id);

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Remove Example"]')!.click());
    expect(picker().textContent).toBe("Match app theme");
    expect(getSetting(terminalSetting).importedSchemes).toEqual([]);
  } finally {
    act(() => root.unmount());
    container.remove();
    setSetting(terminalSetting, original);
    vi.unstubAllGlobals();
  }
});
