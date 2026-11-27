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

async function mount(history = Promise.resolve(["echo saved command"]), completionList = false) {
  const original = getSetting(terminalSetting);
  setSetting(terminalSetting, { ...original, commandHistory: !completionList, completionList });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__TAURI_INTERNALS__", { transformCallback: () => 12 });
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
  const key = (key: string, number: number, init?: KeyboardEventInit) => {
    act(() => terminal.textarea!.dispatchEvent(new KeyboardEvent("keydown", {
      key, keyCode: number, bubbles: true, cancelable: true, ...init,
    })));
  };
  const ghost = () => container.querySelector(".terminal-history-suggestion")?.textContent;
  const shellText = () => terminal.buffer.active.getLine(terminal.buffer.active.cursorY)?.translateToString(true);
  const receive = (text: string) => act(async () => {
    output(text);
    await new Promise<void>((resolve) => terminal.write("", resolve));
  });
  const prompt = (verified = true, cwd?: string) => act(async () => {
    emit({ type: "shellIntegration", event: { type: "availability", status: "available" } });
    output(`\x1b]6973;prompt\x07$ ${verified ? "\x1b]6973;input\x07" : ""}\x1b[?2004h`);
    if (cwd) emit({ type: "cwd", path: cwd });
    emit({ type: "shellIntegration", event: { type: "promptStart", promptId: 1 } });
    await new Promise<void>((resolve) => terminal.write("", resolve));
  });
  return {
    container, bytes, emit, ghost, historyChanged: () => historyChanged?.(), key, prompt, receive, shellText,
    paste: (text: string) => act(() => terminal.paste(text)),
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

it("suggests at the end of an xterm-wrapped input line", async () => {
  const prefix = "echo " + "x".repeat(80);
  const { bytes, ghost, key, paste, prompt, receive, shellText, close } = await mount(Promise.resolve([`${prefix}-tail`]));
  try {
    await prompt();
    paste(prefix);
    await receive(prefix);
    expect(shellText()).toBe("xxxxxxx");
    await vi.waitFor(() => expect(ghost()).toBe("-tail"));
    key("ArrowLeft", 37);
    await receive("\x1b[D");
    expect(ghost()).toBeUndefined();
    key("End", 35);
    expect(bytes().at(-1)).toEqual({ id: 42, data: "\x1b[F" });
    await receive("\x1b[C");
    await vi.waitFor(() => expect(ghost()).toBe("-tail"));
    key("End", 35);
    expect(bytes().at(-1)).toEqual({ id: 42, data: "\x1b[200~-tail\x1b[201~", generation: 0 });
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

it("opens the opt-in list with Ctrl+Space, inserts a choice once and leaves Tab to the shell", async () => {
  const { bytes, container, key, prompt, receive, close } = await mount(undefined, true);
  try {
    await prompt();
    await receive("git ch");
    const open = async () => {
      await act(async () => {
        key(" ", 32, { code: "Space", ctrlKey: true });
        await import("./completion-catalog.json");
      });
      await vi.waitFor(() => expect(container.querySelector('[role="listbox"]')).not.toBeNull());
    };
    await open();
    key("Tab", 9);
    expect(bytes()).toEqual([{ id: 42, data: "\t" }]);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    await receive("e");
    await open();
    expect(container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toBe("checkout");
    key("Enter", 13);
    key("Enter", 13, { repeat: true });
    expect(bytes().at(-1)).toEqual({ id: 42, generation: 0, data: "\x1b[200~ckout \x1b[201~" });
    expect(bytes()).toHaveLength(2);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  } finally { close(); }
});

it("explains an unavailable prompt without sending Ctrl+Space to the shell", async () => {
  const { bytes, container, key, prompt, close } = await mount(undefined, true);
  try {
    await prompt(false);
    key(" ", 32, { code: "Space", ctrlKey: true });
    expect(container.textContent).toContain("Completions are available at the end of an editable shell prompt.");
    expect(bytes()).toEqual([]);
    act(() => setSetting(terminalSetting, { ...getSetting(terminalSetting), shellIntegration: false }));
    key(" ", 32, { code: "Space", ctrlKey: true });
    expect(container.textContent).toContain("Turn on Shell integration in Terminal settings");
    expect(bytes()).toEqual([]);
    act(() => setSetting(terminalSetting, { ...getSetting(terminalSetting), completionList: false }));
    key(" ", 32, { code: "Space", ctrlKey: true });
    expect(container.textContent).not.toContain("Turn on Shell integration in Terminal settings");
    expect(bytes()).toEqual([{ id: 42, data: "\0" }]);
  } finally { close(); }
});

it("lists paths on the current Connection and discards a completion from a previous Connection", async () => {
  const { bytes, container, emit, key, prompt, receive, close } = await mount(undefined, true);
  try {
    let reply!: (value: unknown) => void;
    const response = new Promise((resolve) => { reply = resolve; });
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command !== "terminal_completion_paths") return Promise.resolve(undefined);
      (args as { onStart: { onmessage(value: null): void } }).onStart.onmessage(null);
      return response;
    });
    await prompt(true, "/work");
    act(() => emit({ type: "cwd", path: "/another-directory" }));
    await receive("cat docs/re");
    await act(async () => {
      key(" ", 32, { code: "Space", ctrlKey: true });
      await import("./completion-catalog.json");
    });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("terminal_completion_paths", {
      id: 42, generation: 0, query: { directory: "/work/docs/", prefix: "re", directoriesOnly: false },
      onStart: expect.anything(),
    }));
    act(() => {
      emit({ type: "connection", state: { state: "disconnected", reason: "test disconnect", reportReconnectFailure: false } });
      emit({ type: "connection", state: { state: "connected" } });
    });
    await act(async () => reply({ entries: [{ name: "report", kind: "file" }] }));
    expect(invoke).toHaveBeenCalledWith("terminal_completion_cancel", { id: 42, request: 12 });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(bytes()).toEqual([]);

    vi.mocked(invoke).mockImplementation((command) => Promise.resolve(
      command === "terminal_completion_paths"
        ? { entries: [{ name: "report $HOME", kind: "file" }] }
        : undefined,
    ));
    await receive("\r\n");
    await prompt(true, "/fresh");
    await receive("cat re");
    await act(async () => {
      key(" ", 32, { code: "Space", ctrlKey: true });
      await import("./completion-catalog.json");
    });
    const candidate = container.querySelector<HTMLButtonElement>('[role="option"]');
    expect(candidate?.textContent).toBe("report $HOME");
    act(() => candidate?.click());
    expect(bytes()).toEqual([{ id: 42, generation: 1, data: "\x1b[200~'port $HOME' \x1b[201~" }]);
  } finally { close(); }
});
