import { createInstance } from "i18next";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { resources } from "@/i18n/resources";
import { PasteConfirmDialog } from "./PasteConfirmDialog";
import { planPaste } from "./terminal-input";

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["en", "Paste text with invisible characters?", "Line 1, column 3", "Cancel"],
  ["zh", "粘贴含不可见字符的内容？", "第 1 行，第 3 列", "取消"],
])("shows a localized warning with the character position in %s", async (lng, title, position, cancel) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const i18n = createInstance();
  await i18n.init({ resources, lng, interpolation: { escapeValue: false } });
  const text = "😀a\u202Eb";
  const plan = planPaste(text, false);
  if (!plan || !("ask" in plan)) throw new Error("Expected the paste to require confirmation");

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <PasteConfirmDialog paste={plan.ask} onConfirm={() => {}} onCancel={() => {}} />
        </I18nextProvider>,
      );
    });

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector("h2")?.textContent).toBe(title);
    expect(dialog?.querySelector("pre")?.textContent).toBe("😀a[U+202E]b");
    expect(dialog?.querySelector("mark")?.title).toBe(position);
    expect(document.activeElement?.textContent).toBe(cancel);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
