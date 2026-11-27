import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { quickConnectLabel } from "@/features/connect/quick-connect";
import { hostsStore } from "@/features/hosts/hostsStore";
import { currentPlatform } from "@/features/workspace/shortcuts";
import { emptyTabs, newPane, tabsReducer, type TabsAction, type TabsState } from "@/features/workspace/tabs";
import { restoreWorkspaceLayout, workspaceLayoutSetting } from "@/features/workspace/workspace-layout";
import i18n, { startI18n } from "@/i18n";
import type { ConnectPrompt } from "@/lib/ipc/connect";
import type { Listing } from "@/lib/ipc/files";
import type { Host, HostDraft, QuickConnectTarget } from "@/lib/ipc/hosts";
import type { TerminalMessage } from "@/lib/ipc/terminal";
import type { Transfer } from "@/lib/ipc/transfers";
import { getSetting, startSettings, type SettingsBackend } from "@/lib/storage";
import { ThemeProvider } from "@/theme/ThemeProvider";
import { App } from "./App";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  let nextTerminalId = 0;
  let nextTemporaryId = 0;
  return {
    ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
    Channel: class<T> {
      constructor(public onmessage: (message: T) => void) {}
    },
    invoke: vi.fn(async (command: string, args?: {
      target?: QuickConnectTarget;
      hostId?: string;
      id?: string;
      draft?: HostDraft;
    }) => {
      if (command === "remote_terminal_open" || command === "local_terminal_open") return ++nextTerminalId;
      if (command === "temporary_host_create") {
        const target = { ...args!.target!, user: args!.target!.user ?? "local-user" };
        return { ...host, ...target, id: `temporary-${++nextTemporaryId}`, name: quickConnectLabel(target), auth: { type: "auto" } };
      }
      if (command === "temporary_host_save") {
        if (saveTemporaryError) throw saveTemporaryError;
        const saved = { ...args!.draft!, id: args!.hostId!, groupId: null, forwards: [] };
        savedHosts.push(saved);
        return saved;
      }
      if (command === "files_open" && args?.hostId && panelListings.has(args.hostId)) return args.hostId;
      if (command === "files_open" || command === "files_connect" || command === "files_local_open") return command;
      if (command === "files_list") return panelListings.get(args?.id ?? "") ?? { path: "/", entries: [] };
      if (command === "transfers_copy_remote") return [1];
      if (command === "transfers_watch" || command === "forwards_watch" || command === "connections_watch") return [];
      if (command === "hosts_import_ssh_config") return {
        tree: { hosts: savedHosts, groups: [] },
        report: { imported: ["Imported Host"], skipped: [], issues: [] },
      };
      if (command === "host_tree") return { hosts: savedHosts, groups: [] };
    }),
  };
});

vi.mock("@tauri-apps/plugin-clipboard-manager", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/plugin-clipboard-manager")>(),
  writeText: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

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
let savedHosts: Host[] = [];
let saveTemporaryError: { kind: string; message: string } | undefined;
const panelListings = new Map<string, Listing>();
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
  saveTemporaryError = undefined;
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
  if (savedHosts.length > 0) {
    savedHosts = [];
    await hostsStore.getState().load();
  }
  vi.mocked(invoke).mockClear();
  panelListings.clear();
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

it("splits the focused remote Terminal on the same Host and in its reported directory", async () => {
  await render(workspace({ type: "open", tabId: "work", pane: remote("original") }));
  const remoteOpens = () => vi.mocked(invoke).mock.calls
    .filter(([command]) => command === "remote_terminal_open")
    .map(([, args]) => args as { hostId: string; cwd?: string });

  // No shell report yet: this split opens at the usual login directory.
  await clickButton("Split right");
  expect(remoteOpens()).toHaveLength(2);
  expect(remoteOpens()[1]).toMatchObject({ hostId: host.id });
  expect(remoteOpens()[1]?.cwd).toBeUndefined();

  await sendTerminalMessage({ cwd: "/srv/other" });
  const cwd = "/srv/work space/it's here";
  await sendTerminalMessage({ cwd }, "remote_terminal_open", 1);
  await clickButton("Split down");

  expect(remoteOpens()).toHaveLength(3);
  expect(remoteOpens()[2]).toMatchObject({ hostId: host.id, cwd });
});

it("starts a new Local terminal directly in the focused pane's directory", async () => {
  await render(workspace({ type: "open", tabId: "work", pane: local("original") }));
  const localOpens = () => vi.mocked(invoke).mock.calls
    .filter(([command]) => command === "local_terminal_open")
    .map(([, args]) => (args as { cwd?: string }).cwd);

  await clickButton("Split down");
  expect(localOpens()).toEqual([undefined, undefined]);

  await sendTerminalMessage({ cwd: "/tmp/other" }, "local_terminal_open");
  const cwd = "/tmp/it's here";
  await sendTerminalMessage({ cwd }, "local_terminal_open", 1);
  await clickButton("Split right");

  expect(localOpens()).toEqual([undefined, undefined, cwd]);
});

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
  await clickButton("Terminal", document.querySelector('[aria-label="Settings categories"]')!);
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
  expect(settingsFile.workspacePreferences).toMatchObject({ restoreTabs: "none", confirmClose: false });

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
  expect(settingsFile.workspacePreferences).toMatchObject({ restoreTabs: "none", confirmClose: true });
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

async function openPalette() {
  const modifiers = currentPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true, shiftKey: true };
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "k", code: "KeyK", bubbles: true, cancelable: true, ...modifiers,
  })));
}

async function search(input: HTMLInputElement, query: string) {
  expect(input).not.toBeNull();
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function enter(input: HTMLElement) {
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", code: "Enter", bubbles: true, cancelable: true,
  })));
}

const homeSearch = () => document.querySelector<HTMLInputElement>('input[aria-label="Search Hosts by name, address or user"]')!;
const paletteSearch = () => dialog()!.querySelector<HTMLInputElement>('input[placeholder="Search Hosts, tabs and actions"]')!;
const paletteOptions = () => [...dialog()!.querySelectorAll<HTMLElement>('[role="option"]')];

it("opens a Temporary Host from an empty Home and discards it when its last tab closes", async () => {
  await render(emptyTabs);
  const target = "deploy@[2001:db8::1]:2222";
  await search(homeSearch(), target);
  expect(document.body.textContent).toContain(`Connect to ${target}`);
  await enter(homeSearch());

  const opens = () => vi.mocked(invoke).mock.calls
    .filter(([command]) => command === "remote_terminal_open").map(([, args]) => args as {
      hostId: string;
      onPrompt: { onmessage(message: ConnectPrompt): void };
    });
  expect(opens()).toHaveLength(1);
  const { hostId: id, onPrompt } = opens()[0]!;
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("temporary_host_create", {
    target: { address: "2001:db8::1", user: "deploy", port: 2222 },
  });
  expect(JSON.stringify(settingsFile)).not.toContain(id);

  await act(async () => onPrompt.onmessage({
    type: "password", id: 1, host: "2001:db8::1", user: "deploy", retry: false, canSave: false,
  }));
  expect(dialog()?.querySelector('[role="checkbox"]')).toBeNull();
  expect(dialog()?.textContent).not.toContain("keychain");
  await clickButton("Cancel", dialog()!);

  expect(vi.mocked(invoke)).toHaveBeenCalledWith("files_open", { hostId: id });
  await clickButton("Open SFTP workspace", document.getElementById("files")!);
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("files_connect", expect.objectContaining({ hostId: id }));
  expect(JSON.stringify(settingsFile)).not.toContain(id);
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "host_save")).toBe(false);

  await clickButton("Privacy mode");
  expect(container?.innerHTML).not.toContain("2001:db8::1");
  expect(container?.innerHTML).not.toContain("deploy@");
  await clickButton("Close Temporary Host");
  await clickButton("Close", dialog()!);
  expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("temporary_host_forget", { hostId: id });
  await clickButton("Close SFTP · Temporary Host");
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("temporary_host_forget", { hostId: id });
  expect(document.body.textContent).toContain("No Hosts yet");

  await search(homeSearch(), target);
  await enter(homeSearch());
  expect(opens()).toHaveLength(2);
  expect(opens()[1]?.hostId).not.toBe(id);
});

it("drops a file into another Host's File panel and shows both endpoints in Transfers", async () => {
  const backup = { ...host, id: "backup", name: "Backup Host", defaultDirectory: "/archive" };
  panelListings.set(host.id, {
    path: "/work",
    entries: [{ name: "notes.txt", kind: "file", size: 3, modified: null, permissions: null, linkTarget: null }],
  });
  panelListings.set(backup.id, { path: "/archive", entries: [] });
  await render(workspace(
    { type: "open", tabId: "backup", pane: newPane({ kind: "remote-terminal", host: backup }, "backup") },
    { type: "open", tabId: "source", pane: remote("source") },
  ));

  const dock = document.getElementById("files")!;
  await enter(dock.querySelector<HTMLElement>(`button[aria-label="Show another Host's File panel"]`)!);
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    .find((option) => option.textContent === backup.name);
  expect(item).toBeDefined();
  await act(async () => item!.click());

  const source = dock.querySelector('[role="rowgroup"] [role="row"]')!;
  const target = dock.querySelector('[role="grid"][aria-label="Files in /archive"]')!;
  const targetDropZone = target.parentElement!.parentElement!;
  source.getBoundingClientRect = () => new DOMRect(0, 20, 100, 26);
  targetDropZone.getBoundingClientRect = () => new DOMRect(0, 100, 100, 180);
  const pointer = (element: EventTarget, type: string, y: number) => element.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 1, clientX: 10, clientY: y,
  }));
  act(() => pointer(source, "pointerdown", 30));
  act(() => pointer(document, "pointermove", 42));
  act(() => pointer(target, "pointermove", 145));
  await act(async () => pointer(target, "pointerup", 145));

  const sourceHost = { id: host.id, name: host.name };
  const targetHost = { id: backup.id, name: backup.name };
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("transfers_copy_remote", {
    source: sourceHost, target: targetHost, paths: ["/work/notes.txt"], remoteDir: "/archive",
  });
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "files_rename")).toBe(false);

  const watch = vi.mocked(invoke).mock.calls.find(([command]) => command === "transfers_watch")?.[1] as {
    onEvent: { onmessage(transfer: Transfer): void };
  };
  await act(async () => watch.onEvent.onmessage({
    id: 1, direction: "copy", name: "notes.txt", state: { type: "running" },
    source: "/work/notes.txt", target: "/archive/notes.txt", sourceHost, targetHost,
    bytesDone: 1, bytesTotal: 3, filesDone: 0, filesTotal: 1, unprotected: false,
  }));
  expect(dock.querySelector('[aria-label="Transfers"]')?.textContent).toContain("Test Host → Backup Host");
  expect(dock.querySelector('[title="Test Host · /work/notes.txt → Backup Host · /archive/notes.txt"]')).not.toBeNull();
});

it("puts an exact saved Host ahead of Quick connect in Home and the palette", async () => {
  const saved = { ...host, name: "lab" };
  savedHosts = [{ ...host, id: "prefix", name: "lab-old" }, saved];
  await hostsStore.getState().load();
  await render(workspace({ type: "open", tabId: "home", pane: newPane({ kind: "home" }) }));

  await search(homeSearch(), "LAB");
  expect(document.body.textContent).not.toContain("Connect to LAB");
  await enter(homeSearch());
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("remote_terminal_open", expect.objectContaining({ hostId: saved.id }));

  await openPalette();
  await search(paletteSearch(), "LAB");
  expect(paletteOptions()[0]?.textContent).toContain("lab");
  await enter(paletteSearch());
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "remote_terminal_open")
    .map(([, args]) => (args as { hostId: string }).hostId)).toEqual([saved.id, saved.id]);

  await openPalette();
  await search(paletteSearch(), "testing@lab:2200");
  expect(paletteOptions()[0]?.textContent).toBe("Connect to testing@lab:2200");
  await enter(paletteSearch());
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("temporary_host_create", {
    target: { address: "lab", port: 2200, user: "testing" },
  });
});

it("saves a Temporary Host in place after canceling and retrying the Host editor", async () => {
  await hostsStore.getState().load();
  await render(emptyTabs);
  await search(homeSearch(), "deploy@lab:2200");
  await enter(homeSearch());
  const calls = (command: string) => vi.mocked(invoke).mock.calls.filter(([name]) => name === command);
  const open = calls("remote_terminal_open")[0]?.[1] as { hostId: string } | undefined;
  const id = open?.hostId;
  expect(id).toBeDefined();
  expect(calls("files_open")).toEqual([["files_open", { hostId: id }]]);
  const [tab] = tabIds();
  const terminals = [...testTerminals];
  const fileCloses = calls("files_close");

  await clickButton("Privacy mode");
  expect(container?.innerHTML).not.toContain("deploy@lab");
  await selectTabMenu(tab!.slice(4), "Save as Host");
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Save as Host");
  expect(document.querySelector<HTMLInputElement>("#host-form-address")?.value).toBe("lab");
  expect(document.querySelector<HTMLInputElement>("#host-form-port")?.value).toBe("2200");
  expect(document.querySelector<HTMLInputElement>("#host-form-user")?.value).toBe("deploy");
  await clickButton("Cancel", dialog()!);
  expect(calls("temporary_host_save")).toHaveLength(0);
  expect(hostsStore.getState().tree.hosts).toEqual([]);
  expect(document.getElementById(tab!)?.getAttribute("aria-label")).toBe("Temporary Host (Connected)");

  await clickButton("Save as Host", document.querySelector("footer")!);
  await search(document.querySelector<HTMLInputElement>("#host-form-name")!, "Lab");
  saveTemporaryError = { kind: "io", message: "Disk write failed" };
  await clickButton("Save", dialog()!);
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe("Disk write failed");
  expect(hostsStore.getState().tree.hosts).toEqual([]);

  saveTemporaryError = undefined;
  await clickButton("Save", dialog()!);
  expect(dialog()).toBeNull();
  expect(hostsStore.getState().tree.hosts).toEqual([
    expect.objectContaining({ id, name: "Lab", address: "lab", port: 2200, user: "deploy" }),
  ]);
  expect(document.querySelector('aside button[aria-current="true"]')?.textContent).toContain("Lab");
  expect(tabIds()).toEqual([tab]);
  expect(document.getElementById(tab!)?.getAttribute("aria-label")).toBe("Lab (Connected)");
  expect(document.querySelector('footer button[aria-label="Save as Host"]')).toBeNull();
  expect(container?.innerHTML).not.toContain("deploy@lab");
  expect([...testTerminals]).toEqual(terminals);
  expect(calls("remote_terminal_open")).toHaveLength(1);
  expect(terminalCloses()).toHaveLength(0);
  expect(calls("files_open")).toHaveLength(1);
  expect(calls("files_close")).toEqual(fileCloses);
  expect(calls("temporary_host_forget")).toHaveLength(0);
});

async function paletteAction(title: string) {
  await openPalette();
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.startsWith(title));
  expect(item, title).toBeDefined();
  await act(async () => item!.click());
}

it("masks Host details and tab titles while raw address searches still find the Host", async () => {
  savedHosts = [host, { ...host, id: "unrelated", name: "Other Host", address: "unrelated.test" }];
  await hostsStore.getState().load();
  const privateTitle = `${host.user}@${host.address}`;
  await render(workspace(
    { type: "open", tabId: "work", pane: remote("work") },
    { type: "retitle", paneId: "work", title: privateTitle },
    { type: "open", tabId: "custom", pane: remote("custom") },
    { type: "renameTab", id: "custom", title: privateTitle },
    { type: "open", tabId: "home", pane: newPane({ kind: "home" }, "home") },
  ));

  expect(container?.textContent).toContain(privateTitle);
  await paletteAction("Turn on privacy mode");
  expect(container?.innerHTML.includes(host.address), "Host address appears in the DOM").toBe(false);
  expect(container?.innerHTML.includes(host.user), "Host user appears in the DOM").toBe(false);
  for (const id of ["tab-work", "tab-custom"]) {
    const tab = document.getElementById(id)!;
    expect(tab.textContent).toBe(host.name);
    expect(tab.getAttribute("aria-label")).toContain(host.name);
    expect(tab.title).toContain(host.name);
  }

  for (const label of ["Search Hosts", "Search Hosts by name, address or user"]) {
    await search(document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!, host.address);
  }
  expect(document.querySelector('[title="Double-click to connect"]')?.textContent).toContain(host.name);
  expect(document.querySelector("#tabpanel-home")?.textContent).toContain(host.name);
  expect(container?.textContent).not.toContain("Other Host");
  expect(container?.textContent).not.toContain(host.address);

  await openPalette();
  await search(paletteSearch(), host.address);
  const results = paletteOptions();
  expect(results).toHaveLength(2);
  expect(results[0]?.textContent).toBe("Quick connect");
  expect(results[1]?.textContent).toContain(host.name);
  for (const result of results) {
    expect(result.outerHTML).not.toContain(host.address);
    expect(result.outerHTML).not.toContain(host.user);
  }
});

it("persists privacy mode and lets the status bar and palette toggle it", async () => {
  const initialTabs = workspace({ type: "open", tabId: "work", pane: remote("work") });
  const status = () => document.querySelector("footer")!;
  const toggle = () => status().querySelector('[aria-label="Privacy mode"]');

  await render(initialTabs);
  expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
  expect(status().textContent).toContain("deploy@example.com");

  await clickButton("Privacy mode", status());
  expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
  expect(status().textContent).toContain(host.name);
  expect(status().innerHTML).not.toContain(host.address);
  expect(status().innerHTML).not.toContain(host.user);

  await unmount();
  await startSettings(settingsBackend);
  await render(initialTabs);
  expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
  expect(status().innerHTML).not.toContain(host.address);

  await paletteAction("Turn off privacy mode");
  expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
  expect(status().textContent).toContain("deploy@example.com");
});

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

it("opens one global Transfers tab from the status bar and command palette", async () => {
  await render(workspace({ type: "open", tabId: "home", pane: newPane({ kind: "home" }) }));
  await clickButton("Open Transfers");
  const globalTab = document.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Transfers"]')!;
  const pane = document.getElementById(globalTab.getAttribute("aria-controls")!)!;
  expect(pane.hidden).toBe(false);
  const watch = vi.mocked(invoke).mock.calls.find(([command]) => command === "transfers_watch")?.[1] as {
    onEvent: { onmessage(transfer: Transfer): void };
  };
  const shared = {
    id: 1, direction: "download", name: "notes.txt", source: "/srv/notes.txt", target: "/local/notes.txt",
    sourceHost: { id: host.id, name: host.name }, bytesDone: 1, bytesTotal: 2, filesDone: 0, filesTotal: 1,
    unprotected: false,
  } satisfies Omit<Transfer, "state">;
  await act(async () => watch.onEvent.onmessage({ ...shared, state: { type: "running" } }));
  expect(document.querySelector('button[aria-label="Open Transfers"]')?.textContent).toBe("Transfers: 1");
  expect(pane.querySelector("h2")?.textContent).toBe("Test Host");
  expect(pane.querySelector('button[aria-label="Show in file manager"]')).toBeNull();

  await act(async () => watch.onEvent.onmessage({ ...shared, state: { type: "done" }, bytesDone: 2, filesDone: 1 }));
  expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe("");
  await clickButton("Show in file manager");
  expect(invoke).toHaveBeenCalledWith("transfer_reveal_download", { id: 1 });
  await clickButton("Completed");
  await clickButton("Clear completed");
  expect(pane.textContent).toContain("No completed transfers.");
  expect(invoke).toHaveBeenCalledWith("transfers_remove", { ids: [1] });

  await act(async () => document.getElementById("tab-home")!.click());
  expect(pane.hidden).toBe(true);
  await paletteAction("Open Transfers");
  expect(pane.hidden).toBe(false);
  expect(tabIds()).toEqual(["tab-home", globalTab.id]);
});

it("announces transfer results when the Transfers panel is hidden and offers error dismissal", async () => {
  await render(workspace(
    { type: "open", tabId: "home", pane: newPane({ kind: "home" }) },
    { type: "open", tabId: "sftp", pane: newPane({ kind: "sftp", host }) },
    { type: "open", tabId: "terminal", pane: local("shell") },
  ));
  const watch = vi.mocked(invoke).mock.calls.find(([command]) => command === "transfers_watch")?.[1] as {
    onEvent: { onmessage(transfer: Transfer): void };
  };
  const emit = (id: number, state: Transfer["state"]) => act(async () => watch.onEvent.onmessage({
    id, direction: "upload", name: `file-${id}`, state,
    source: "/work/file", target: "/remote/file",
    bytesDone: 1, bytesTotal: 1, filesDone: 1, filesTotal: 1, unprotected: false,
  }));
  const polite = () => document.querySelector('[role="status"][aria-live="polite"]')?.textContent;
  const assertive = () => document.querySelector('[role="alert"][aria-live="assertive"]')?.textContent;

  await emit(1, { type: "done" });
  expect(document.querySelector('#files [aria-label="Transfers"]')).not.toBeNull();
  expect(polite()).toBe("");

  await act(async () => document.querySelector<HTMLButtonElement>("#tab-home")!.click());
  expect(document.querySelector("#files")).toBeNull();
  expect(document.querySelector('#tabpanel-sftp[hidden] [aria-label="Transfers"]')).not.toBeNull();
  await emit(2, { type: "done" });
  await emit(3, { type: "failed", message: "Permission denied" });
  await emit(3, { type: "failed", message: "Permission denied" });
  expect(polite()).toBe("Transfer complete: file-2");
  expect(assertive()).toBe("Transfer failed: file-3. Permission denied");

  const dismiss = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Dismiss notification: Transfer failed: file-3. Permission denied"]',
  );
  expect(dismiss).not.toBeNull();
  await act(async () => dismiss!.click());
  expect(assertive()).toBe("");
  await act(async () => document.querySelector<HTMLButtonElement>(
    'button[aria-label="Dismiss notification: Transfer complete: file-2"]',
  )!.click());

  await act(async () => document.querySelector<HTMLButtonElement>("#tab-sftp")!.click());
  await emit(4, { type: "done" });
  expect(polite()).toBe("");
  await act(async () => document.querySelector<HTMLButtonElement>(
    '#tabpanel-sftp button[aria-label="Hide transfers"]',
  )!.click());
  await emit(5, { type: "done" });
  expect(polite()).toBe("Transfer complete: file-5");
  await act(async () => document.querySelector<HTMLButtonElement>(
    'button[aria-label="Dismiss notification: Transfer complete: file-5"]',
  )!.click());

});

it("announces the OpenSSH import result and still opens the detailed report", async () => {
  await render(workspace({ type: "open", tabId: "home", pane: newPane({ kind: "home" }) }));
  const importButton = [...document.querySelectorAll<HTMLButtonElement>("#tabpanel-home button")]
    .find((button) => button.textContent === "Import ~/.ssh/config")!;
  await act(async () => importButton.click());
  expect(dialog()?.textContent).toContain("Imported Host");
  expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent)
    .toBe("Imported 1, skipped 0, could not import 0.");
  await act(async () => dialog()!.querySelector("button")!.click());
  const dismiss = document.querySelector<HTMLButtonElement>('button[aria-label^="Dismiss notification: Imported"]');
  await act(async () => dismiss!.click());
});

it("confirms an explicit File panel copy after writing the path to the clipboard", async () => {
  panelListings.set(host.id, { path: "/work", entries: [] });
  await render(workspace({ type: "open", tabId: "work", pane: remote("shell") }));
  const copy = document.querySelector<HTMLButtonElement>('button[aria-label="Copy path"]')!;
  expect(copy.disabled).toBe(false);
  await act(async () => copy.click());
  expect(writeText).toHaveBeenCalledWith("/work");
  expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe("Copied to clipboard.");
  await act(async () => document.querySelector<HTMLButtonElement>(
    'button[aria-label="Dismiss notification: Copied to clipboard."]',
  )!.click());

  vi.mocked(writeText).mockRejectedValueOnce(new Error("Clipboard unavailable"));
  await act(async () => copy.click());
  expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe("");
});
