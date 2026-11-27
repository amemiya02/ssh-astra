import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import i18n, { startI18n } from "@/i18n";
import { localStorageBackend, startSettings } from "@/lib/storage";
import { ThemeProvider } from "@/theme/ThemeProvider";
import { SettingsPage } from "./SettingsPage";

it("applies interface zoom and font changes and saves them alongside the theme", async () => {
  startI18n();
  await i18n.changeLanguage("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;

  const key = "appearance-test";
  localStorage.setItem(key, JSON.stringify({ appearance: { theme: "nord", zoom: 150 } }));
  const backend = localStorageBackend(localStorage, key);
  await startSettings(backend);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);

  try {
    act(() => root.render(<ThemeProvider><SettingsPage /></ThemeProvider>));
    const zoom = container.querySelector<HTMLSelectElement>('select[aria-label="Interface zoom"]')!;
    expect(zoom.value).toBe("125");

    act(() => {
      zoom.value = "90";
      zoom.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.documentElement.style.getPropertyValue("--interface-scale")).toBe("0.9");

    const font = container.querySelector<HTMLInputElement>('input[aria-label="Interface font"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(font, "Avenir Next");
      font.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => font.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(document.documentElement.style.getPropertyValue("--interface-font")).toBe('"Avenir Next", var(--system-ui-font)');
    expect((await backend.load()).appearance).toMatchObject({ theme: "nord", zoom: 90, fontFamily: "Avenir Next" });
  } finally {
    act(() => root.unmount());
    container.remove();
    document.documentElement.style.removeProperty("--interface-scale");
    document.documentElement.style.removeProperty("--interface-font");
    delete document.documentElement.dataset.browserZoom;
    localStorage.removeItem(key);
    await startSettings(backend);
    vi.unstubAllGlobals();
  }
});

it("searches across categories and languages, then returns to normal category navigation", async () => {
  startI18n();
  await i18n.changeLanguage("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;

  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const search = () => container.querySelector<HTMLInputElement>('input[type="search"]')!;
  const enterQuery = (query: string) => {
    const input = search();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const nav = () => container.querySelector("nav")!;
  const category = (label: string) => [...nav().querySelectorAll("button")].find((button) => button.textContent === label)!;

  try {
    act(() => root.render(<ThemeProvider><SettingsPage /></ThemeProvider>));
    expect(category("Appearance").getAttribute("aria-current")).toBe("true");
    expect(container.querySelector('[aria-label="Keepalive interval"]')).toBeNull();

    enterQuery("心跳");
    expect(container.querySelector('[aria-label="Keepalive interval"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Follow system appearance"]')).toBeNull();
    expect(nav().querySelector("[aria-current]")).toBeNull();

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Clear settings search"]')!.click());
    expect(search().value).toBe("");
    expect(category("Appearance").getAttribute("aria-current")).toBe("true");

    await act(() => i18n.changeLanguage("zh"));
    enterQuery("heartbeat");
    expect(container.querySelector('[aria-label="Keepalive 间隔"]')).not.toBeNull();

    enterQuery("no-such-setting");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("未找到匹配的设置。");

    act(() => category("文件").click());
    expect(search().value).toBe("");
    expect(category("文件").getAttribute("aria-current")).toBe("true");
    expect(container.querySelector('[aria-label="显示权限列"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
    vi.unstubAllGlobals();
  }
});
