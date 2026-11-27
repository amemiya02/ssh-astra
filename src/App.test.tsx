import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { currentPlatform } from "@/features/workspace/shortcuts";
import { emptyTabs, newPane, tabsReducer, type TabsAction, type TabsState } from "@/features/workspace/tabs";
import { restoreWorkspaceLayout, workspaceLayoutSetting } from "@/features/workspace/workspace-layout";
import i18n, { startI18n } from "@/i18n";
import type { Host } from "@/lib/ipc/hosts";
import type { TerminalMessage } from "@/lib/ipc/terminal";
import { getSetting, startSettings, type SettingsBackend } from "@/lib/storage";
import { ThemeProvider } from "@/theme/ThemeProvider";
import { App } from "./App";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  let nextTerminalId = 0;
  return {
    ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
    Channel: class<T> {
      constructor(public onmessage: (message: T) => void) {}
    },
    invoke: vi.fn(async (command: string) => {
      if (command === "remote_terminal_open" || command === "local_terminal_open") return ++nextTerminalId;
      if (command === "transfers_watch" || command === "forwards_watch") return [];
    }),
  };
});

// Exercise the real app and Terminal lifecycle without a renderer or native backend.
const testTerminals = new Set<Terminal>();
vi.mock("@/features/terminal/XtermView", () => ({
  XtermView: ({ attach }: { attach(terminal: Terminal): () => void }) => {
    useEffect(() => {
      const terminal = new Terminal();
      testTerminals.add(terminal);
      const detach = attach(terminal);
      return () => {
        testTerminals.delete(terminal);
        detach();
        terminal.dispose();
      };
    }, [attach]);
    return null;
  },
}));

const host: Host = {
  id: "test-host", name: "Test Host", address: "example.com", port: 22, user: "deploy",
  auth: { type: "password" }, jumpHost: null, groupId: null, forwards: [],
};
const remote = (id: string) => newPane({ kind: "remote-terminal", host }, id);
const local = (id: string) => newPane({ kind: "local-terminal" }, id);

function workspace(...actions: TabsAction[]) {
  return actions.reduce(tabsReducer, emptyTabs);
}

let settingsFile: Record<string, unknown>;
const settingsBackend: SettingsBackend = {
  load: async () => settingsFile,
  save: async (section, value) => { settingsFile[section] = value; },
};
let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  HTMLElement.prototype.scrollIntoView ??= () => {};
  startI18n();
});

beforeEach(async () => {
  settingsFile = { workspacePreferences: { restoreTabs: "none" } };
  await startSettings(settingsBackend);
  await i18n.changeLanguage("en");
});

async function unmount() {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
}

afterEach(async () => {
  await unmount();
  vi.mocked(invoke).mockClear();
  vi.unstubAllGlobals();
});

async function render(initialTabs: TabsState) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <ThemeProvider>
      <TooltipProvider>
        <App initialTabs={initialTabs} />
      </TooltipProvider>
    </ThemeProvider>,
  ));
}

const dialog = () => document.querySelector('[role="dialog"]');
const terminalCloses = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "terminal_close");
const tabIds = () => [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.id);

async function sendTerminalMessage(message: TerminalMessage, openCommand = "remote_terminal_open", index = 0) {
  const openCall = vi.mocked(invoke).mock.calls.filter(([command]) => command === openCommand)[index];
  const { onEvent } = openCall?.[1] as { onEvent: { onmessage(message: TerminalMessage): void } };
  await act(async () => onEvent.onmessage(message));
}

async function flushTerminalOutput() {
  await act(async () => {
    await Promise.all([...testTerminals].map((terminal) => new Promise<void>((resolve) => terminal.write("", resolve))));
  });
}

async function ringTerminal(openCommand = "remote_terminal_open") {
  await sendTerminalMessage([7], openCommand);
  await flushTerminalOutput();
}

it("marks background Terminal output until the tab is visited, including when the active tab is split", async () => {
  await render(workspace(
    { type: "open", tabId: "background", pane: remote("background") },
    { type: "open", tabId: "work", pane: remote("visible") },
    { type: "split", pane: local("focused"), orientation: "horizontal" },
  ));
  const background = document.querySelector<HTMLButtonElement>("#tab-background")!;
  const work = document.querySelector<HTMLButtonElement>("#tab-work")!;
  expect(background.querySelector("[data-unread-output]")).toBeNull();

  await sendTerminalMessage([65], "remote_terminal_open", 1);
  expect(work.querySelector("[data-unread-output]")).toBeNull();
  await sendTerminalMessage([65]);
  const dot = background.querySelector("[data-unread-output]");
  expect(dot).not.toBeNull();
  expect(background.getAttribute("aria-label")).toContain("Unread Terminal output");
  await sendTerminalMessage([66]);
  expect(background.querySelector("[data-unread-output]")).toBe(dot);

  await act(async () => background.click());
  expect(background.querySelector("[data-unread-output]")).toBeNull();
  expect(background.getAttribute("aria-label")).not.toContain("Unread Terminal output");
  await sendTerminalMessage([67]);
  expect(background.querySelector("[data-unread-output]")).toBeNull();
  await sendTerminalMessage([68], "local_terminal_open");
  expect(work.querySelector("[data-unread-output]")).not.toBeNull();
});

it("restores each Local terminal in its own last reported directory", async () => {
  const localOpens = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "local_terminal_open");
  await render(workspace(
    { type: "open", tabId: "work", pane: local("a") },
    { type: "split", orientation: "horizontal", pane: local("b") },
  ));
  const paths = ["/home/tester/work space", "/tmp/files"];
  expect(localOpens()).toHaveLength(paths.length);
  for (const [index, [, args]] of localOpens().entries()) {
    const { onEvent } = args as { onEvent: { onmessage(message: TerminalMessage): void } };
    await act(async () => onEvent.onmessage({ cwd: paths[index]! }));
  }

  expect(localOpens()).toHaveLength(paths.length);
  await unmount();
  await startSettings(settingsBackend);
  vi.mocked(invoke).mockClear();
  await render(restoreWorkspaceLayout(getSetting(workspaceLayoutSetting), [], "layout"));

  expect(localOpens().map(([, args]) => (args as { cwd?: string }).cwd)).toEqual(paths);
});

async function closePaneShortcut() {
  const modifiers = currentPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true, shiftKey: true };
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "w", code: "KeyW", bubbles: true, cancelable: true, ...modifiers,
  })));
}

async function selectTabMenu(tabId: string, label: string) {
  const tab = document.getElementById(`tab-${tabId}`)!;
  await act(async () => tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  const menuItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === label);
  expect(menuItem, label).toBeDefined();
  await act(async () => menuItem!.click());
}

async function clickButton(label: string, scope: ParentNode = document) {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.getAttribute("aria-label") === label || button.textContent === label
    || [...(button.labels ?? [])].some((element) => element.textContent === label));
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

it("applies the live bell choice to running Terminals and limits repeated sound", async () => {
  const play = vi.fn();
  vi.stubGlobal("AudioContext", class {
    state = "running";
    currentTime = 0;
    createOscillator() {
      return { frequency: { value: 0 }, connect() {}, start: play, stop() {} };
    }
    createGain() {
      return {
        connect() {},
        gain: { setValueAtTime() {}, linearRampToValueAtTime() {} },
      };
    }
    async close() {}
  });
  await render(workspace(
    { type: "open", tabId: "remote", pane: remote("remote") },
    { type: "open", tabId: "local", pane: local("local") },
  ));
  const remoteTab = document.getElementById("tab-remote")!;
  const localTab = document.getElementById("tab-local")!;

  await ringTerminal();
  expect(remoteTab.querySelector("[data-terminal-bell]")).toBeNull();
  expect(play).not.toHaveBeenCalled();

  await clickButton("Settings");
  const setting = document.querySelector('[role="radiogroup"][aria-label="Terminal bell"]')!;
  expect(setting.querySelector('[aria-checked="true"]')?.textContent).toBe("None");
  await clickButton("Flash tab", setting);
  expect(settingsFile.terminal).toMatchObject({ bell: "flash" });
  await act(async () => localTab.click());
  await sendTerminalMessage([...new TextEncoder().encode("\x1b]2;title\x07")], "local_terminal_open");
  await flushTerminalOutput();
  expect(localTab.querySelector("[data-terminal-bell]")).toBeNull();
  await ringTerminal("local_terminal_open");
  expect(localTab.querySelector("[data-terminal-bell]")).not.toBeNull();
  expect(remoteTab.querySelector("[data-terminal-bell]")).toBeNull();
  expect(play).not.toHaveBeenCalled();

  await clickButton("Settings");
  await clickButton("Sound", setting);
  expect(localTab.querySelector("[data-terminal-bell]")).toBeNull();
  expect(play).not.toHaveBeenCalled();
  await ringTerminal();
  await ringTerminal("local_terminal_open");
  expect(remoteTab.querySelector("[data-terminal-bell]")).toBeNull();
  expect(play).toHaveBeenCalledTimes(1);
});

it("asks before a tab closes its connected remote Terminal and Cancel keeps it running", async () => {
  await render(workspace({ type: "open", tabId: "work", pane: remote("a") }));
  expect(document.querySelector("#tab-work")?.getAttribute("aria-label")).toBe("Test Host (Connected)");

  await clickButton("Close Test Host");
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Close 1 connected Terminal?");
  expect(terminalCloses()).toHaveLength(0);

  await clickButton("Cancel", dialog()!);
  expect(dialog()).toBeNull();
  expect(document.querySelector("#tab-work")).not.toBeNull();
  expect(terminalCloses()).toHaveLength(0);

  await clickButton("Close Test Host");
  await clickButton("Close", dialog()!);
  expect(dialog()).toBeNull();
  expect(document.querySelector("#tab-work")).toBeNull();
  expect(terminalCloses()).toHaveLength(1);
});


it.each([
  ["Close other tabs", "Close 3 connected Terminals?", ["tab-anchor", "tab-locked"], 3],
  ["Close tabs to the right", "Close 2 connected Terminals?", ["tab-left", "tab-anchor", "tab-locked"], 2],
] as const)("%s asks once and counts each connected remote pane that would close", async (label, title, survivors, count) => {
  await render(workspace(
    { type: "open", tabId: "left", pane: remote("left") },
    { type: "open", tabId: "anchor", pane: local("anchor") },
    { type: "open", tabId: "locked", pane: remote("locked") },
    { type: "setTabLocked", id: "locked", locked: true },
    { type: "open", tabId: "split", pane: remote("first") },
    { type: "split", pane: remote("second"), orientation: "horizontal" },
    { type: "split", pane: local("local"), orientation: "vertical" },
    { type: "open", tabId: "restored", pane: { ...remote("restored"), restoreConnection: "manual" } },
  ));
  expect(document.querySelector("#tab-locked")?.getAttribute("aria-label")).toBe("Test Host (Connected, Locked)");

  await selectTabMenu("anchor", label);
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(dialog()?.querySelector("h2")?.textContent).toBe(title);
  expect(terminalCloses()).toHaveLength(0);

  await clickButton("Close", dialog()!);
  expect(dialog()).toBeNull();
  expect(tabIds()).toEqual(survivors);
  expect(terminalCloses()).toHaveLength(count + 1);
});

it("confirms the close-pane shortcut for one connected split and protects the last pane of a locked tab", async () => {
  await render(workspace(
    { type: "open", tabId: "work", pane: remote("first") },
    { type: "split", pane: remote("second"), orientation: "vertical" },
    { type: "setTabLocked", id: "work", locked: true },
  ));
  await closePaneShortcut();
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Close 1 connected Terminal?");
  expect(document.activeElement?.textContent).toBe("Cancel");

  await closePaneShortcut();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await clickButton("Close", dialog()!);
  expect(document.querySelector("#pane-first")).not.toBeNull();
  expect(document.querySelector("#pane-second")).toBeNull();
  expect(terminalCloses()).toHaveLength(1);

  await closePaneShortcut();
  expect(dialog()).toBeNull();
  expect(tabIds()).toEqual(["tab-work"]);
  expect(terminalCloses()).toHaveLength(1);
});

it("closes a Local terminal and an unconnected restored pane without asking", async () => {
  await render(workspace(
    { type: "open", tabId: "restored", pane: { ...remote("restored"), restoreConnection: "manual" } },
    { type: "open", tabId: "work", pane: local("local") },
  ));
  await closePaneShortcut();
  expect(dialog()).toBeNull();
  expect(tabIds()).toEqual(["tab-restored"]);
  expect(terminalCloses()).toHaveLength(1);

  await clickButton("Close Test Host");
  expect(dialog()).toBeNull();
  expect(tabIds()).toEqual([]);
  expect(terminalCloses()).toHaveLength(1);
});

it.each([
  ["reconnecting", { connection: { state: "reconnecting", attempt: 1, attempts: 3 } }],
  ["disconnected", { connection: { state: "disconnected", reason: "Connection closed" } }],
  ["exited", { exitCode: 0 }],
] satisfies [string, TerminalMessage][])("closes a %s remote Terminal without asking", async (_, message) => {
  await render(workspace({ type: "open", tabId: "work", pane: remote("a") }));
  await sendTerminalMessage(message);

  await clickButton("Close Test Host");
  expect(dialog()).toBeNull();
  expect(tabIds()).toEqual([]);
});

it("saves the confirmation opt-out and lets Settings turn it back on", async () => {
  const initialTabs = workspace(
    { type: "open", tabId: "first", pane: remote("first") },
    { type: "renameTab", id: "first", title: "First" },
    { type: "open", tabId: "second", pane: remote("second") },
    { type: "renameTab", id: "second", title: "Second" },
  );
  await render(initialTabs);
  await clickButton("Close First");
  await clickButton("Don't ask again", dialog()!);
  await clickButton("Cancel", dialog()!);
  expect(dialog()).toBeNull();
  expect(tabIds()).toEqual(["tab-first", "tab-second"]);

  await clickButton("Close First");
  expect(dialog()?.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
  await clickButton("Don't ask again", dialog()!);
  await clickButton("Close", dialog()!);
  expect(settingsFile.workspacePreferences).toEqual({ restoreTabs: "none", confirmClose: false });

  await unmount();
  await startSettings(settingsBackend);
  await render(initialTabs);
  await clickButton("Close First");
  expect(dialog()).toBeNull();
  expect(tabIds()).toEqual(["tab-second"]);

  await clickButton("Settings");
  const setting = document.querySelector('[role="radiogroup"][aria-label="Confirm Terminal close"]')!;
  expect(setting.querySelector('[aria-checked="true"]')?.textContent).toBe("Off");
  await clickButton("On", setting);
  await clickButton("Close Second");
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Close 1 connected Terminal?");
  expect(settingsFile.workspacePreferences).toEqual({ restoreTabs: "none", confirmClose: true });
});

it("shows the count and confirmation controls in Chinese", async () => {
  await i18n.changeLanguage("zh");
  await render(workspace({ type: "open", tabId: "work", pane: remote("a") }));
  await closePaneShortcut();

  const confirmation = dialog()!;
  expect(confirmation.querySelector("h2")?.textContent).toBe("关闭 1 个已连接的终端？");
  expect(confirmation.querySelector("label")?.textContent).toBe("不再询问");
  expect(document.activeElement?.textContent).toBe("取消");
  await clickButton("关闭", confirmation);
  expect(tabIds()).toEqual([]);
});

async function broadcastShortcut(inWindow = false) {
  const modifiers = currentPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true };
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "B", code: "KeyB", bubbles: true, cancelable: true, shiftKey: true, altKey: inWindow, ...modifiers,
  })));
}

const broadcastMarks = () => [...document.querySelectorAll("[data-broadcast-recipient]")].map((mark) => mark.parentElement?.id);

it("marks connected Terminals in the chosen Broadcast scope and lets the status bar turn it off", async () => {
  await render(workspace(
    { type: "open", tabId: "other", pane: remote("other") },
    { type: "open", tabId: "restored", pane: { ...remote("restored"), restoreConnection: "manual" } },
    { type: "open", tabId: "work", pane: remote("remote") },
    { type: "split", pane: local("local"), orientation: "horizontal" },
  ));

  await broadcastShortcut();
  expect(broadcastMarks()).toEqual(["pane-remote", "pane-local"]);
  expect(document.querySelector('[aria-label="Turn off Broadcast"]')?.textContent).toBe("Broadcast · This tab");

  await broadcastShortcut(true);
  expect(broadcastMarks()).toEqual(["pane-other", "pane-remote", "pane-local"]);
  expect(document.querySelector('[aria-label="Turn off Broadcast"]')?.textContent).toBe("Broadcast · This window");

  await sendTerminalMessage({ connection: { state: "reconnecting", attempt: 1, attempts: 3 } });
  expect(broadcastMarks()).toEqual(["pane-remote", "pane-local"]);
  await sendTerminalMessage({ connection: { state: "connected" } });
  expect(broadcastMarks()).toEqual(["pane-other", "pane-remote", "pane-local"]);

  await clickButton("Turn off Broadcast");
  expect(broadcastMarks()).toEqual([]);
  expect(document.querySelector('[aria-label="Turn off Broadcast"]')).toBeNull();

  await broadcastShortcut();
  expect(broadcastMarks()).toEqual(["pane-remote", "pane-local"]);
  await broadcastShortcut();
  expect(broadcastMarks()).toEqual([]);
});

async function paletteAction(title: string) {
  const modifiers = currentPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true, shiftKey: true };
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "k", code: "KeyK", bubbles: true, cancelable: true, ...modifiers,
  })));
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.startsWith(title));
  expect(item, title).toBeDefined();
  await act(async () => item!.click());
}

it("starts and stops Broadcast from the palette and ends it when its tab or window closes", async () => {
  const initialTabs = workspace(
    { type: "open", tabId: "other", pane: local("other") },
    { type: "renameTab", id: "other", title: "Other" },
    { type: "open", tabId: "work", pane: local("work") },
    { type: "renameTab", id: "work", title: "Work" },
  );
  await render(initialTabs);
  await paletteAction("Broadcast to this tab");
  expect(broadcastMarks()).toEqual(["pane-work"]);

  await paletteAction("Turn off Broadcast");
  expect(broadcastMarks()).toEqual([]);

  await paletteAction("Broadcast to this tab");
  await act(async () => document.getElementById("tab-other")!.click());
  expect(document.querySelector('[aria-label="Turn off Broadcast"]')?.textContent).toBe("Broadcast · Work");
  await clickButton("Close Work");
  expect(broadcastMarks()).toEqual([]);
  expect(document.querySelector('[aria-label="Turn off Broadcast"]')).toBeNull();

  await paletteAction("Broadcast to this window");
  expect(broadcastMarks()).toEqual(["pane-other"]);
  await unmount();
  await render(initialTabs);
  expect(broadcastMarks()).toEqual([]);
  expect(document.querySelector('[aria-label="Turn off Broadcast"]')).toBeNull();
});
