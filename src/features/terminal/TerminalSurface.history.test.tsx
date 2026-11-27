import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { startI18n } from "@/i18n";
import { listCommandHistory, watchCommandHistory } from "@/lib/ipc/command-history";
import type { TerminalEvent } from "@/lib/ipc/terminal";
import { getSetting, setSetting } from "@/lib/storage";
import { ThemeContext } from "@/theme/theme-context";
import { appearanceSetting } from "@/theme/theme";
import { appThemes } from "@/theme/themes";
import { TerminalSurface } from "./TerminalSurface";
import { terminalSetting } from "./terminal-prefs";

vi.hoisted(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
vi.mock("@tauri-apps/api/core", { spy: true });
vi.mock("@/lib/ipc/command-history", { spy: true });
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    activate() { throw new Error("WebGL unavailable in jsdom"); }
    dispose() {}
  },
}));

beforeAll(startI18n);

async function mount(history = Promise.resolve(["echo saved command"])) {
  const original = getSetting(terminalSetting);
  setSetting(terminalSetting, { ...original, commandHistory: true });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ addListener() {}, removeListener() {} }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(32 * 8);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(10);
  const openXterm = vi.spyOn(Terminal.prototype, "open");
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.mocked(listCommandHistory).mockReturnValue(history);
  let historyChanged: (() => void) | undefined;
  vi.mocked(watchCommandHistory).mockImplementation((_host, refresh) => {
    historyChanged = refresh;
    queueMicrotask(refresh);
    return () => { historyChanged = undefined; };
  });
  let emit!: (event: TerminalEvent) => void;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await act(async () => root.render(
    <ThemeContext.Provider value={{
      theme: appThemes.light,
      settings: appearanceSetting.defaults,
      setTheme() {}, setLightTheme() {}, setDarkTheme() {}, setZoom() {}, setFontFamily() {}, preview() {},
    }}>
      <TooltipProvider>
        <TerminalSurface paneId="pane" host={{ id: "host", name: "Test Host" }} label="Test Host" historyHostId="host"
          open={async (_size, onEvent) => { emit = onEvent; return 42; }} />
      </TooltipProvider>
    </ThemeContext.Provider>,
  ));
  const terminal = openXterm.mock.contexts[0];
  if (!(terminal instanceof Terminal)) throw new Error("Terminal did not open");
  const output = (text: string) => emit({ type: "output", data: new TextEncoder().encode(text) });
  const bytes = () => vi.mocked(invoke).mock.calls.flatMap(([command, args]) => command === "terminal_write" ? [args] : []);
  const key = (key: string, number: number) => {
    act(() => terminal.textarea!.dispatchEvent(new KeyboardEvent("keydown", {
      key, keyCode: number, bubbles: true, cancelable: true,
    })));
  };
  const ghost = () => container.querySelector(".terminal-history-suggestion")?.textContent;
  const shellText = () => terminal.buffer.active.getLine(terminal.buffer.active.cursorY)?.translateToString(true);
  const receive = (text: string) => act(async () => {
    output(text);
    await new Promise<void>((resolve) => terminal.write("", resolve));
  });
  const prompt = (verified = true) => act(async () => {
    emit({ type: "shellIntegration", event: { type: "availability", status: "available" } });
    output(`\x1b]6973;prompt\x07$ ${verified ? "\x1b]6973;input\x07" : ""}\x1b[?2004h`);
    emit({ type: "shellIntegration", event: { type: "promptStart", promptId: 1 } });
    await new Promise<void>((resolve) => terminal.write("", resolve));
  });
  return {
    bytes, emit, ghost, historyChanged: () => historyChanged?.(), key, prompt, receive, shellText,
    close() {
      act(() => root.unmount());
      container.remove();
      vi.restoreAllMocks();
      vi.clearAllMocks();
      vi.unstubAllGlobals();
      setSetting(terminalSetting, original);
    },
  };
}

it.each([["ArrowRight", 39], ["End", 35]] as const)("accepts the displayed suffix with %s without submitting", async (accept, keyCode) => {
  const { bytes, ghost, key, prompt, receive, shellText, close } = await mount();
  try {
    await prompt();
    key("e", 69);
    key("c", 67);
    await receive("e");
    expect(ghost()).toBeUndefined();
    await receive("c");
    await vi.waitFor(() => expect(ghost()).toBe("ho saved command"));
    expect(shellText()).toBe("$ ec");
    expect(bytes()).toEqual([{ id: 42, data: "e" }, { id: 42, data: "c" }]);
    key(accept, keyCode);
    expect(bytes().at(-1)).toEqual({ id: 42, data: "\x1b[200~ho saved command\x1b[201~", generation: 0 });
    expect(ghost()).toBeUndefined();
    await receive("ho saved command");
    expect(shellText()).toBe("$ echo saved command");
    expect(listCommandHistory).toHaveBeenCalledTimes(1);
  } finally { close(); }
});

it("keeps shell Tab completion and hides the suggestion away from the line end, in the alternate buffer and when disabled", async () => {
  const { bytes, ghost, key, prompt, receive, close } = await mount();
  try {
    await prompt();
    key("e", 69);
    await receive("e");
    await vi.waitFor(() => expect(ghost()).toBe("cho saved command"));
    key("ArrowLeft", 37);
    await receive("\x1b[D");
    expect(ghost()).toBeUndefined();
    key("ArrowRight", 39);
    expect(bytes().at(-1)).toEqual({ id: 42, data: "\x1b[C" });
    await receive("\x1b[C");
    await vi.waitFor(() => expect(ghost()).toBe("cho saved command"));
    key("Tab", 9);
    expect(bytes().at(-1)).toEqual({ id: 42, data: "\t" });
    await receive("c");
    await vi.waitFor(() => expect(ghost()).toBe("ho saved command"));
    act(() => setSetting(terminalSetting, { ...getSetting(terminalSetting), commandHistory: false }));
    expect(ghost()).toBeUndefined();
    act(() => setSetting(terminalSetting, { ...getSetting(terminalSetting), commandHistory: true }));
    key("h", 72);
    await receive("h");
    await vi.waitFor(() => expect(ghost()).toBe("o saved command"));
    await receive("\x1b[?1049h");
    expect(ghost()).toBeUndefined();
    key("End", 35);
    expect(bytes().at(-1)).toEqual({ id: 42, data: "\x1b[F" });
  } finally { close(); }
});

it("requires a verified input boundary before suggesting history", async () => {
  const { bytes, ghost, key, prompt, receive, close } = await mount();
  try {
    await prompt(false);
    key("e", 69);
    await receive("e");
    expect(ghost()).toBeUndefined();
    key("End", 35);
    expect(bytes().at(-1)).toEqual({ id: 42, data: "\x1b[F" });
  } finally { close(); }
});

it("ignores a history reply from the previous Connection after reconnecting", async () => {
  let resolveHistory!: (commands: string[]) => void;
  const { bytes, emit, ghost, key, prompt, receive, close } = await mount(new Promise((resolve) => { resolveHistory = resolve; }));
  try {
    await prompt();
    key("e", 69);
    await receive("e");
    expect(ghost()).toBeUndefined();
    vi.mocked(listCommandHistory).mockResolvedValue(["echo fresh command"]);
    await act(async () => {
      emit({ type: "connection", state: { state: "disconnected", reason: "test disconnect", reportReconnectFailure: false } });
      emit({ type: "connection", state: { state: "connected" } });
    });
    await receive("\r\n");
    await prompt();
    key("e", 69);
    await receive("e");
    await vi.waitFor(() => expect(ghost()).toBe("cho fresh command"));
    await act(async () => resolveHistory(["echo stale command"]));
    key("End", 35);
    expect(bytes().at(-1)).toEqual({ id: 42, data: "\x1b[200~cho fresh command\x1b[201~", generation: 1 });
  } finally { close(); }
});

it("withdraws a visible suggestion when Command history is cleared", async () => {
  const { ghost, key, prompt, receive, historyChanged, close } = await mount();
  try {
    await prompt();
    key("e", 69);
    await receive("e");
    await vi.waitFor(() => expect(ghost()).toBe("cho saved command"));
    vi.mocked(listCommandHistory).mockResolvedValue([]);
    await act(async () => historyChanged());
    expect(ghost()).toBeUndefined();
    expect(listCommandHistory).toHaveBeenCalledTimes(2);
  } finally { close(); }
});
