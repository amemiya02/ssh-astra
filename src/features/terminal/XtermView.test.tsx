import { openUrl } from "@tauri-apps/plugin-opener";
import type { Terminal } from "@xterm/xterm";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { startI18n } from "@/i18n";
import { ThemeContext } from "@/theme/theme-context";
import { appThemes } from "@/theme/themes";
import { XtermView } from "./XtermView";

vi.hoisted(() => {
  // xterm checks for a canvas while its module loads.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    activate() { throw new Error("WebGL unavailable in jsdom"); }
    dispose() {}
  },
}));

it("shows and opens the OSC 8 destination with the same click as a plain link", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ addListener() {}, removeListener() {} }));
  // jsdom has no layout. Give xterm an 8×10 character measurement so it can hit-test real buffer cells.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(32 * 8);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(10);

  startI18n();

  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let terminal!: Terminal;
  try {
    act(() => root.render(
      <ThemeContext.Provider value={{
        theme: appThemes.light,
        settings: { theme: "system", lightTheme: "light", darkTheme: "dark" },
        setTheme() {},
        setLightTheme() {},
        setDarkTheme() {},
        preview() {},
      }}>
        <XtermView active attach={(xterm) => {
          terminal = xterm;
          return () => {};
        }} />
      </ThemeContext.Provider>,
    ));
    const surface = terminal.element!.querySelector<HTMLElement>(".xterm-screen")!;
    surface.style.padding = "0px";
    const write = (text: string) => act(async () => new Promise<void>((resolve) => terminal.write(text, resolve)));
    const tooltip = () => container.querySelector('[role="tooltip"]')?.textContent;
    const mouse = (type: string, row: number) =>
      surface.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 4, clientY: 2 + row * 12 }));
    const hover = (row: number) => act(() => { mouse("mousemove", row); });
    const click = (row: number) => act(() => {
      mouse("mousedown", row);
      mouse("mouseup", row);
    });
    const link = (uri: string, name: string) => `\x1b]8;id=link;${uri}\x1b\\${name}\x1b]8;;\x1b\\\r\n`;

    await write("https://example.com/plain\r\n");
    await write(link("https://example.com/real?item=2", "Build report"));
    await write(link("mailto:help@example.com", "Support"));
    await write(link("file:///tmp/private", "Unsupported scheme"));
    await write(link("https://example.com/%xyz", "Malformed URI"));
    await write(link("https://example.com/a\u202Eb", "Direction control"));

    hover(0);
    click(0);
    expect(openUrl).toHaveBeenLastCalledWith("https://example.com/plain");

    hover(1);
    expect(tooltip()).toBe("https://example.com/real?item=2");
    click(1);
    expect(openUrl).toHaveBeenLastCalledWith("https://example.com/real?item=2");

    hover(2);
    expect(tooltip()).toBe("mailto:help@example.com");
    act(() => { mouse("mouseleave", 2); });
    expect(tooltip()).toBeUndefined();
    hover(1);
    hover(2);
    click(2);
    expect(openUrl).toHaveBeenLastCalledWith("mailto:help@example.com");

    for (const row of [3, 4, 5]) {
      hover(row);
      expect(tooltip()).toBeUndefined();
      click(row);
    }
    expect(openUrl).toHaveBeenCalledTimes(3);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
