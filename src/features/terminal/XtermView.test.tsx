import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BroadcastPaneContext, createBroadcast } from "@/features/workspace/broadcast";
import { currentPlatform } from "@/features/workspace/shortcuts";
import type { Terminal } from "@xterm/xterm";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { shortcutSetting } from "@/features/workspace/shortcut-settings";
import { startI18n } from "@/i18n";
import { getSetting, setSetting } from "@/lib/storage";
import { ThemeContext } from "@/theme/theme-context";
import { appearanceSetting } from "@/theme/theme";
import { appThemes } from "@/theme/themes";
import { XtermView } from "./XtermView";
import { terminalSetting } from "./terminal-prefs";

vi.hoisted(() => {
  // xterm checks for a canvas while its module loads.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: vi.fn(), writeText: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    activate() { throw new Error("WebGL unavailable in jsdom"); }
    dispose() {}
  },
}));

beforeAll(startI18n);

function mountTerminal(broadcast?: ReturnType<typeof createBroadcast>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ addListener() {}, removeListener() {} }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  // jsdom has no layout. Give xterm an 8×10 character measurement so it can hit-test real buffer cells.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(32 * 8);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(10);

  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let terminal!: Terminal;
  const input: string[] = [];
  act(() => root.render(
    <ThemeContext.Provider value={{
      theme: appThemes.light,
      settings: appearanceSetting.defaults,
      setTheme() {},
      setLightTheme() {},
      setDarkTheme() {},
      setZoom() {},
      setFontFamily() {},
      preview() {},
    }}>
      <BroadcastPaneContext.Provider value={broadcast && { broadcast, tabId: "work", paneId: "source" }}>
        <TooltipProvider>
          <XtermView active attach={(xterm) => {
            terminal = xterm;
            const subscription = xterm.onData((data) => input.push(data));
            return () => subscription.dispose();
          }} />
        </TooltipProvider>
      </BroadcastPaneContext.Provider>
    </ThemeContext.Provider>,
  ));
  return {
    container,
    terminal,
    input,
    cleanup() {
      act(() => root.unmount());
      container.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    },
  };
}

function openContextMenu(terminal: Terminal) {
  return act(async () => terminal.element!.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, button: 2, clientX: 12, clientY: 12,
  })));
}

function menuItem(label: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === label);
}

async function chooseMenuItem(label: string) {
  const item = menuItem(label);
  expect(item).toBeDefined();
  await act(async () => item!.click());
}

it("selects all Terminal output and copies the xterm selection from the right-click menu", async () => {
  const original = getSetting(terminalSetting);
  setSetting(terminalSetting, { ...original, copyOnSelect: false });
  const { terminal, cleanup } = mountTerminal();
  vi.mocked(writeText).mockResolvedValue(undefined);
  try {
    await act(async () => new Promise<void>((resolve) => terminal.write("Build passed", resolve)));
    await openContextMenu(terminal);
    expect(menuItem("Copy")?.getAttribute("aria-disabled")).toBe("true");
    await chooseMenuItem("Select All");
    expect(terminal.getSelection().trim()).toBe("Build passed");

    act(() => terminal.select(6, 0, 6));
    await openContextMenu(terminal);
    await chooseMenuItem("Copy");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("passed");
    await vi.waitFor(() => expect(document.activeElement).toBe(terminal.textarea));
  } finally {
    cleanup();
    vi.mocked(writeText).mockReset();
    setSetting(terminalSetting, original);
  }
});

it("confirms menu paste before sending bracketed input to the Terminal and its Broadcast peers", async () => {
  const { terminal, input, inTab, otherTab, cleanup } = broadcastFixture();
  vi.mocked(readText).mockResolvedValue("one\ntwo");
  try {
    await act(async () => new Promise<void>((resolve) => terminal.write("\x1b[?2004h", resolve)));
    await openContextMenu(terminal);
    await chooseMenuItem("Paste");
    expect(pasteDialog()?.querySelector("h2")?.textContent).toBe("Paste 2 lines?");
    expect(input).toEqual([]);
    expect(inTab).not.toHaveBeenCalled();
    await answerPaste("Paste");
    const bytes = "\x1b[200~one\rtwo\x1b[201~";
    expect(input).toEqual([bytes]);
    expect(inTab).toHaveBeenCalledExactlyOnceWith(bytes);
    expect(otherTab).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(document.activeElement).toBe(terminal.textarea));
  } finally {
    cleanup();
    vi.mocked(readText).mockReset();
  }
});

it("right-clicks straight into the same paste path when direct paste is selected", async () => {
  const original = getSetting(terminalSetting);
  setSetting(terminalSetting, { ...original, rightClickPaste: true });
  const { terminal, input, cleanup } = mountTerminal();
  vi.mocked(readText).mockResolvedValue("one\ntwo");
  try {
    await openContextMenu(terminal);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(pasteDialog()?.querySelector("h2")?.textContent).toBe("Paste 2 lines?");
    expect(input).toEqual([]);
    await answerPaste("Paste");
    expect(input).toEqual(["one\rtwo"]);
  } finally {
    cleanup();
    vi.mocked(readText).mockReset();
    setSetting(terminalSetting, original);
  }
});

it("opens the Terminal menu with Shift+F10 and moves focus to Find when selected", async () => {
  const { terminal, input, cleanup } = mountTerminal();
  const shiftF10 = new KeyboardEvent("keydown", { key: "F10", code: "F10", shiftKey: true, bubbles: true, cancelable: true });
  try {
    await act(async () => terminal.textarea!.dispatchEvent(shiftF10));
    expect(shiftF10.defaultPrevented).toBe(true);
    expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
    const find = menuItem("Find");
    expect(find).toBeDefined();
    await act(async () => {
      find!.focus();
      find!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Find in Terminal"));
    expect(input).toEqual([]);
  } finally {
    cleanup();
  }
});

it("clears the Terminal display and scrollback without typing a shell command", async () => {
  const { terminal, input, cleanup } = mountTerminal();
  try {
    await act(async () => new Promise<void>((resolve) => terminal.write("Old output\r\n$ ", resolve)));
    await openContextMenu(terminal);
    await chooseMenuItem("Clear screen");
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("$ ");
    expect(input).toEqual([]);
  } finally {
    cleanup();
  }
});

it("uses a changed Find shortcut in an already open Terminal", () => {
  const { container, terminal, cleanup } = mountTerminal();
  const previous = getSetting(shortcutSetting);
  const mac = currentPlatform() === "mac";
  const dispatch = (key: string, code: string, modifiers: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...modifiers });
    act(() => { terminal.textarea!.dispatchEvent(event); });
    return event.defaultPrevented;
  };

  try {
    setSetting(shortcutSetting, { find: { code: "KeyY", key: "Y", mods: mac ? ["meta", "shift"] : ["ctrl", "shift"] } });
    dispatch("f", "KeyF", mac ? { metaKey: true } : { ctrlKey: true, shiftKey: true });
    expect(container.querySelector('[aria-label="Find in Terminal"]')).toBeNull();
    expect(dispatch("Y", "KeyY", mac ? { metaKey: true, shiftKey: true } : { ctrlKey: true, shiftKey: true })).toBe(true);
    expect(container.querySelector('[aria-label="Find in Terminal"]')).not.toBeNull();
  } finally {
    setSetting(shortcutSetting, previous);
    cleanup();
  }
});

it("shows and opens the OSC 8 destination with the same click as a plain link", async () => {
  const { container, terminal, cleanup } = mountTerminal();
  try {
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
    cleanup();
  }
});

it("applies appearance settings to an open Terminal without losing its output", async () => {
  const original = getSetting(terminalSetting);
  const { container, terminal, cleanup } = mountTerminal();
  try {
    await act(async () => new Promise<void>((resolve) => terminal.write("Existing output", resolve)));
    const appearance = {
      fontWeight: 700,
      lineHeight: 1.5,
      letterSpacing: 2,
      cursorStyle: "underline" as const,
      cursorBlink: false,
      wordSeparator: " /",
    };
    act(() => setSetting(terminalSetting, { ...original, ...appearance }));
    expect(terminal.options).toMatchObject(appearance);
    expect(container.querySelector(".xterm")).toBe(terminal.element);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("Existing output");
  } finally {
    cleanup();
    setSetting(terminalSetting, original);
  }
});

it("zooms the open Terminal with Ctrl or Cmd and wheel, within the saved font-size limits", () => {
  const original = getSetting(terminalSetting);
  setSetting(terminalSetting, { ...original, fontSize: 31 });
  const { terminal, cleanup } = mountTerminal();
  const wheel = (deltaY: number, mods: WheelEventInit = {}) => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, ...mods });
    act(() => terminal.element!.dispatchEvent(event));
    return event.defaultPrevented;
  };
  try {
    wheel(-100);
    expect(terminal.options.fontSize).toBe(31);

    expect(wheel(-100, { ctrlKey: true })).toBe(true);
    expect(wheel(-100, { ctrlKey: true })).toBe(true);
    expect(terminal.options.fontSize).toBe(32);
    expect(getSetting(terminalSetting).fontSize).toBe(32);

    act(() => setSetting(terminalSetting, { ...original, fontSize: 9 }));
    expect(wheel(100, { metaKey: true })).toBe(true);
    expect(wheel(100, { metaKey: true })).toBe(true);
    expect(terminal.options.fontSize).toBe(8);
    expect(getSetting(terminalSetting).fontSize).toBe(8);
  } finally {
    cleanup();
    setSetting(terminalSetting, original);
  }
});

function broadcastFixture() {
  const broadcast = createBroadcast();
  const inTab = vi.fn();
  const otherTab = vi.fn();
  const mounted = mountTerminal(broadcast);
  broadcast.updateWorkspace("source", ["work", "other"], ["source", "peer", "other-peer", "new-peer"]);
  const removeSource = broadcast.register("work", "source", vi.fn());
  const removePeer = broadcast.register("work", "peer", inTab);
  broadcast.register("other", "other-peer", otherTab);
  broadcast.toggle("tab", "work");
  return { broadcast, inTab, otherTab, removeSource, removePeer, ...mounted };
}

it("sends the focused Terminal's keys to live Broadcast recipients and keeps xterm's protocol replies local", async () => {
  const { terminal, input, inTab, otherTab, broadcast, cleanup } = broadcastFixture();
  const key = () => act(() => terminal.textarea!.dispatchEvent(new KeyboardEvent("keydown", {
    bubbles: true, cancelable: true, key: "x", code: "KeyX", keyCode: 88,
  })));

  try {
    key();
    await act(async () => new Promise<void>((resolve) => terminal.write("\x1b[6n", resolve)));
    expect(input).toEqual(["x", "\x1b[1;1R"]);
    expect(inTab.mock.calls).toEqual([["x"]]);
    expect(otherTab).not.toHaveBeenCalled();

    broadcast.toggle("window", "work");
    key();
    expect(inTab.mock.calls).toEqual([["x"], ["x"]]);
    expect(otherTab.mock.calls).toEqual([["x"]]);

    act(() => terminal.textarea!.blur());
    key();
    expect(inTab).toHaveBeenCalledTimes(2);
    expect(otherTab).toHaveBeenCalledTimes(1);
  } finally {
    cleanup();
  }
});

it("relays IME text committed by xterm as keyboard input", async () => {
  const { terminal, input, inTab, cleanup } = broadcastFixture();
  const textarea = terminal.textarea!;
  try {
    await act(async () => {
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      textarea.value = "终端";
      textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "终端" }));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(input).toEqual(["终端"]);
    expect(inTab.mock.calls).toEqual([["终端"]]);
  } finally {
    cleanup();
  }
});

const pasteDialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

function pasteText(terminal: Terminal, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  act(() => terminal.textarea!.dispatchEvent(event));
}

async function answerPaste(label: string) {
  const button = [...pasteDialog()!.querySelectorAll("button")].find((node) => node.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it.each([
  { text: "first\nsecond", expected: "first\rsecond", multiline: true, title: "Paste 2 lines?" },
  { text: "first\nsec\u202Eond", expected: "first\rsec\u202Eond", multiline: false, title: "Paste text with invisible characters?" },
])("asks once before Broadcasting $title", async ({ text, expected, multiline, title }) => {
  const original = getSetting(terminalSetting);
  setSetting(terminalSetting, { ...original, confirmMultilinePaste: multiline });
  const { terminal, input, inTab, otherTab, broadcast, cleanup } = broadcastFixture();
  broadcast.toggle("window", "work");

  try {
    await act(async () => new Promise<void>((resolve) => terminal.write("\x1b[?2004h", resolve)));
    pasteText(terminal, text);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(pasteDialog()?.querySelector("h2")?.textContent).toBe(title);
    if (!multiline) expect(pasteDialog()?.querySelector("mark")?.title).toBe("Line 2, column 4");
    expect(input).toEqual([]);
    expect(inTab).not.toHaveBeenCalled();
    expect(otherTab).not.toHaveBeenCalled();

    await answerPaste("Cancel");
    expect(pasteDialog()).toBeNull();
    expect(input).toEqual([]);
    expect(inTab).not.toHaveBeenCalled();
    expect(otherTab).not.toHaveBeenCalled();

    pasteText(terminal, text);
    await answerPaste("Paste");
    expect(pasteDialog()).toBeNull();
    const bytes = "\x1b[200~" + expected + "\x1b[201~";
    expect(input).toEqual([bytes]);
    expect(inTab.mock.calls).toEqual([[bytes]]);
    expect(otherTab.mock.calls).toEqual([[bytes]]);
  } finally {
    cleanup();
    setSetting(terminalSetting, original);
  }
});

it("does not add new or reconnected peers to a paste that is awaiting approval", async () => {
  const { terminal, input, inTab, otherTab, broadcast, removePeer, cleanup } = broadcastFixture();
  const reconnected = vi.fn();
  const newlyConnected = vi.fn();
  broadcast.toggle("window", "work");

  try {
    pasteText(terminal, "first\nsecond");
    expect(pasteDialog()).not.toBeNull();

    removePeer();
    broadcast.register("work", "peer", reconnected);
    broadcast.register("work", "new-peer", newlyConnected);
    await answerPaste("Paste");
    expect(input).toEqual(["first\rsecond"]);
    expect(otherTab.mock.calls).toEqual([["first\rsecond"]]);
    expect(inTab).not.toHaveBeenCalled();
    expect(reconnected).not.toHaveBeenCalled();
    expect(newlyConnected).not.toHaveBeenCalled();
  } finally {
    cleanup();
  }
});

it("drops a pending Broadcast paste if the source shell restarts before confirmation", async () => {
  const { terminal, input, inTab, broadcast, removeSource, cleanup } = broadcastFixture();
  try {
    pasteText(terminal, "first\nsecond");
    expect(pasteDialog()).not.toBeNull();

    removeSource();
    broadcast.register("work", "source", vi.fn());
    await answerPaste("Paste");
    expect(input).toEqual([]);
    expect(inTab).not.toHaveBeenCalled();
  } finally {
    cleanup();
  }
});

it("decorates wrapped keywords in the normal buffer without changing selected text", async () => {
  const { terminal, cleanup } = mountTerminal();
  const decorate = vi.spyOn(terminal, "registerDecoration");
  const write = (text: string) => act(async () => new Promise<void>((resolve) => terminal.write(text, resolve)));
  try {
    terminal.resize(10, 5);
    await write("终12345 ERROR");
    await vi.waitFor(() => expect(decorate).toHaveBeenCalledTimes(2));
    expect(decorate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      x: 8, width: 2, foregroundColor: appThemes.light.terminal.red,
    }));
    expect(decorate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      x: 0, width: 3, foregroundColor: appThemes.light.terminal.red,
    }));

    act(() => terminal.select(8, 0, 5));
    expect(terminal.getSelection()).toBe("ERROR");

    await write("\x1b[?1049h\x1b[HERROR");
    expect(terminal.buffer.active.type).toBe("alternate");
    expect(decorate.mock.calls.every(([{ marker }]) => marker.isDisposed)).toBe(true);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(decorate).toHaveBeenCalledTimes(2);

    await write("\x1b[?1049l");
    await vi.waitFor(() => expect(decorate).toHaveBeenCalledTimes(4));
  } finally {
    cleanup();
  }
});

it("skips a long logical line even if its first screen row contains a keyword", async () => {
  const { terminal, cleanup } = mountTerminal();
  const decorate = vi.spyOn(terminal, "registerDecoration");
  try {
    terminal.resize(40, 5);
    await act(async () => new Promise<void>((resolve) =>
      terminal.write("ERROR " + "x".repeat(1_000) + "\r\nWARN", resolve)));
    act(() => terminal.scrollToTop());
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(decorate.mock.calls.every(([{ marker }]) => marker.isDisposed)).toBe(true);

    act(() => terminal.scrollToBottom());
    const activeDecorations = () => decorate.mock.calls.map(([options]) => options).filter(({ marker }) => !marker.isDisposed);
    await vi.waitFor(() => expect(activeDecorations()).toEqual([expect.objectContaining({
      x: 0, width: 4, foregroundColor: appThemes.light.terminal.yellow,
    })]));
    expect(decorate.mock.calls.every(([{ foregroundColor }]) => foregroundColor !== appThemes.light.terminal.red)).toBe(true);
  } finally {
    cleanup();
  }
});
