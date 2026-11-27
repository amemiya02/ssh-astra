import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { emit, TauriEvent } from "@tauri-apps/api/event";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, Update } from "@tauri-apps/plugin-updater";
import { Terminal } from "@xterm/xterm";
import { act, Fragment, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { quickConnectLabel } from "@/features/connect/quick-connect";
import { hostsStore } from "@/features/hosts/hostsStore";
import { updatesStore } from "@/features/updates/updatesStore";
import { currentPlatform } from "@/features/workspace/shortcuts";
import { emptyTabs, newPane, tabsReducer, type TabsAction, type TabsState } from "@/features/workspace/tabs";
import { restoreWorkspaceLayout, serializeWorkspaceLayout, workspaceLayoutSetting } from "@/features/workspace/workspace-layout";
import i18n, { startI18n } from "@/i18n";
import type { ConnectPrompt } from "@/lib/ipc/connect";
import type { Listing } from "@/lib/ipc/files";
import type { ForwardEvent, PortForward } from "@/lib/ipc/forwards";
import type { Host, HostDraft, HostImportSource, HostOsChange, QuickConnectTarget } from "@/lib/ipc/hosts";
import type { Snippet } from "@/lib/ipc/snippets";
import type { TerminalMessage } from "@/lib/ipc/terminal";
import type { Transfer } from "@/lib/ipc/transfers";
import { getSetting, startSettings, type SettingsBackend } from "@/lib/storage";
import { ThemeProvider } from "@/theme/ThemeProvider";
import { App } from "./App";

vi.hoisted(() => {
  // The Terminal renderer detects canvas support at import time.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

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
      shellId?: string;
      source?: HostImportSource;
      draft?: HostDraft;
      onPrompt?: PromptChannel;
    }) => {
      if (command === "remote_terminal_open") {
        const connect = args?.hostId && remoteOpenFixtures.get(args.hostId);
        if (connect) await connect(args.onPrompt!);
        return ++nextTerminalId;
      }
      if (command === "local_terminal_open") return {
        id: ++nextTerminalId,
        shellProgram: localShellPrograms.get(args?.shellId ?? "") ?? "zsh",
        wslDistribution: args?.shellId?.startsWith("wsl:") ? args.shellId.slice(4) : null,
      };
      if (command === "local_terminal_wsl_paths") return {
        shellProgram: "fish", paths: ["/custom/c/some folder/it's.txt"],
      };
      if (command === "local_terminal_shells") return [
        { id: "/bin/zsh", label: "/bin/zsh" },
        { id: "/bin/bash", label: "/bin/bash" },
      ];
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
      if (command === "host_save") {
        const previous = savedHosts.find((candidate) => candidate.id === args!.id)!;
        const saved = { ...args!.draft!, id: previous.id, groupId: previous.groupId, forwards: previous.forwards };
        savedHosts = savedHosts.map((candidate) => candidate.id === saved.id ? saved : candidate);
        return saved;
      }
      if (command === "files_open" && args?.hostId && panelListings.has(args.hostId)) return args.hostId;
      if (command === "files_open" || command === "files_connect" || command === "files_local_open") return command;
      if (command === "files_list") return panelListings.get(args?.id ?? "") ?? { path: "/", entries: [] };
      if (command === "files_remote_home") return "/home/deploy";
      if (command === "transfers_upload" || command === "transfers_copy_remote") return [1];
      if (command === "transfers_watch") return initialTransfers;
      if (command === "snippets_list") return snippetLibrary;
      if (command === "forwards_watch") return initialForwards;
      if (command === "connections_watch") return initialHeld;
      if (command === "quit_live_connection_count") return liveConnectionCount;
      if (command === "hosts_import_source" && args?.source?.kind === "csv") return {
        tree: { hosts: savedHosts, groups: [] },
        report: {
          imported: ["CSV Host"],
          skipped: ["Existing Host"],
          issues: [{ entry: "", line: 3, dropped: true, problem: { kind: "csvInvalidPort" } }],
          proxyCommands: [],
        },
      };
      if (command === "hosts_import_source" && args?.source?.kind === "putty") return {
        tree: { hosts: savedHosts, groups: [] },
        report: {
          imported: ["Staging server"],
          skipped: [],
          issues: [{ entry: "Staging server", dropped: false, problem: { kind: "puttyCredentials" } }],
          proxyCommands: [],
        },
      };
      if (command === "hosts_import_source") return {
        tree: { hosts: savedHosts, groups: [] },
        report: {
          imported: ["Imported Host"],
          skipped: [],
          issues: [],
          proxyCommands: [{ host: "Imported Host", command: 'nc "%h" %p' }],
        },
      };
      if (command === "host_tree" || command === "host_tree_watch") return { hosts: savedHosts, groups: [] };
    }),
  };
});

vi.mock("@tauri-apps/plugin-clipboard-manager", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/plugin-clipboard-manager")>(),
  writeText: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/plugin-dialog")>(),
  open: vi.fn(async () => importPath),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-updater", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/plugin-updater")>(),
  check: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

const fileDragListeners = new Set<(event: { payload: DragDropEvent }) => void>();
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    async onDragDropEvent(listener: (event: { payload: DragDropEvent }) => void) {
      fileDragListeners.add(listener);
      return () => { fileDragListeners.delete(listener); };
    },
    setZoom: async () => {},
  }),
}));

// Exercise the real app and Terminal lifecycle without a renderer or native backend.
const testTerminals = new Set<Terminal>();
let renderTerminalMenu = false;
vi.mock("@/features/terminal/XtermView", async (importOriginal) => {
  const { XtermView } = await importOriginal<typeof import("@/features/terminal/XtermView")>();
  function TestTerminal({ attach }: { attach(terminal: Terminal): () => void }) {
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
  }
  return { XtermView: (props: React.ComponentProps<typeof XtermView>) =>
    renderTerminalMenu ? <XtermView {...props} /> : <TestTerminal {...props} /> };
});

const host: Host = {
  id: "test-host", name: "Test Host", address: "example.com", port: 22, user: "deploy",
  auth: { type: "password" }, jumpHost: null, groupId: null, forwards: [],
};
let savedHosts: Host[] = [];
let importPath: string | null;
let snippetLibrary: Snippet[] = [];
let initialTransfers: Transfer[] = [];
let initialForwards: ForwardEvent[] = [];
let initialHeld: string[] = [];
let liveConnectionCount: number | undefined;
let saveTemporaryError: { kind: string; message: string } | undefined;
const panelListings = new Map<string, Listing>();
type PromptChannel = { onmessage(message: ConnectPrompt): void };
const remoteOpenFixtures = new Map<string, (channel: PromptChannel) => Promise<void>>();
const localShellPrograms = new Map<string, string>();
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
    addListener() {},
    removeListener() {},
  })) as typeof window.matchMedia;
  HTMLElement.prototype.scrollIntoView ??= () => {};
  startI18n();
});

beforeEach(async () => {
  saveTemporaryError = undefined;
  importPath = null;
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
  renderTerminalMenu = false;
  snippetLibrary = [];
  if (savedHosts.length > 0) {
    savedHosts = [];
    await hostsStore.getState().load();
  }
  initialTransfers = [];
  initialForwards = [];
  initialHeld = [];
  liveConnectionCount = undefined;
  vi.mocked(invoke).mockClear();
  vi.mocked(openFileDialog).mockClear();
  vi.mocked(check).mockReset();
  vi.mocked(openUrl).mockClear();
  vi.mocked(relaunch).mockReset();
  updatesStore.setState({ status: { type: "idle" } });
  panelListings.clear();
  remoteOpenFixtures.clear();
  localShellPrograms.clear();
  clearMocks();
  vi.unstubAllGlobals();
});

async function render(initialTabs: TabsState, strict = false) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const Wrapper = strict ? StrictMode : Fragment;
  await act(async () => root!.render(
    <Wrapper>
      <ThemeProvider>
        <TooltipProvider>
          <App initialTabs={initialTabs} />
        </TooltipProvider>
      </ThemeProvider>
    </Wrapper>,
  ));
}

const desktopIPC = vi.fn();

function enableDesktopWindow() {
  vi.stubGlobal("isTauri", true);
  mockWindows("main");
  desktopIPC.mockClear();
  mockIPC(desktopIPC, { shouldMockEvents: true });
}

async function requestWindowClose() {
  await act(async () => emit(TauriEvent.WINDOW_CLOSE_REQUESTED));
}

const windowDestroys = () => desktopIPC.mock.calls.filter(([command]) => command === "plugin:window|destroy");
const dialog = () => document.querySelector('[role="dialog"]');
const terminalCloses = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "terminal_close");
const tabIds = () => [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.id);
const remoteOpenHostIds = () => vi.mocked(invoke).mock.calls
  .filter(([command]) => command === "remote_terminal_open")
  .map(([, args]) => (args as { hostId: string }).hostId);

it("opens each startup Host once and leaves a restored split's Host disconnected in layout-only mode", async () => {
  const restored = { ...host, openOnStartup: true };
  const optedIn = { ...host, name: "Startup Host", id: "startup", openOnStartup: true };
  const manual = { ...host, name: "Manual Host", id: "manual" };
  savedHosts = [restored, optedIn, manual];
  await hostsStore.getState().load();
  const saved = serializeWorkspaceLayout(workspace(
    { type: "open", tabId: "restored-tab", pane: local("restored-local") },
    { type: "split", orientation: "horizontal", pane: remote("restored-remote") },
  ));
  await render(restoreWorkspaceLayout(saved, savedHosts, "layout"), true);

  expect(tabIds()).toHaveLength(2);
  expect(document.getElementById("tab-restored-tab")).not.toBeNull();
  expect(document.getElementById("pane-restored-remote")?.textContent).toContain("Connect");
  expect(document.querySelector('[role="tab"][aria-label="Startup Host (Connected)"]')).not.toBeNull();
  expect(remoteOpenHostIds()).toEqual([optedIn.id]);
});

it("connects startup Hosts after restoring connections and continues after an ordinary connection failure", async () => {
  const restored = { ...host, openOnStartup: true };
  const broken = { ...host, name: "Offline Startup Host", id: "offline", openOnStartup: true };
  const optedIn = { ...host, name: "Startup Host", id: "startup", openOnStartup: true };
  const manual = { ...host, name: "Manual Host", id: "manual" };
  savedHosts = [broken, optedIn, manual, restored];
  let rejectLogin!: (error: unknown) => void;
  const login = new Promise<void>((_resolve, reject) => { rejectLogin = reject; });
  remoteOpenFixtures.set(broken.id, ({ onmessage }) => {
    onmessage({ type: "password", id: 1, host: broken.name, user: broken.user, retry: false, canSave: false });
    return login;
  });
  await hostsStore.getState().load();
  const saved = serializeWorkspaceLayout(workspace({ type: "open", tabId: "restored-tab", pane: remote("restored-remote") }));
  await render(restoreWorkspaceLayout(saved, savedHosts, "connect"), true);

  expect(remoteOpenHostIds()).toEqual([restored.id, broken.id]);
  expect(dialog()?.textContent).toContain(broken.name);
  await search(dialog()!.querySelector<HTMLInputElement>('input[type="password"]')!, "fixture-password");
  await clickButton("Connect", dialog()!);
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("prompt_answer", {
    id: 1, answer: { type: "password", password: "fixture-password", save: false },
  });
  await act(async () => rejectLogin({ kind: "authenticationFailed", message: "All methods rejected" }));

  expect(remoteOpenHostIds()).toEqual([restored.id, broken.id, optedIn.id]);
  expect(tabIds()).toHaveLength(3);
  const failedTab = document.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Offline Startup Host (Disconnected)"]')!;
  await act(async () => failedTab.click());
  const failedPanel = document.getElementById(failedTab.getAttribute("aria-controls")!)!;
  expect(failedPanel.hidden).toBe(false);
  expect(failedPanel.textContent).toContain("All methods rejected");
  expect(failedPanel.textContent).toContain("Retry");

  await act(async () => hostsStore.getState().saveHost({ ...manual, openOnStartup: true }, manual.id));
  expect(tabIds()).toHaveLength(3);
  expect(remoteOpenHostIds()).toEqual([restored.id, broken.id, optedIn.id]);
});

async function sendTerminalMessage(message: TerminalMessage, openCommand = "remote_terminal_open", index = 0) {
  const openCall = vi.mocked(invoke).mock.calls.filter(([command]) => command === openCommand)[index];
  const { onEvent } = openCall?.[1] as { onEvent: { onmessage(message: TerminalMessage): void } };
  await act(async () => onEvent.onmessage(message));
}

async function dropFiles(selector: string, paths: string[]) {
  const target = document.querySelector(selector);
  expect(target).not.toBeNull();
  const original = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true, value: (x: number, y: number) => x === 100 && y === 200 ? target : null,
  });
  const scale = window.devicePixelRatio || 1;
  const position = new PhysicalPosition(100 * scale, 200 * scale);
  try {
    await act(async () => {
      for (const listener of fileDragListeners) {
        listener({ payload: { type: "drop", position, paths } });
      }
    });
  } finally {
    if (original) Object.defineProperty(document, "elementFromPoint", original);
    else Reflect.deleteProperty(document, "elementFromPoint");
  }
}

const uploads = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "transfers_upload");

it("uploads system files to the split Terminal under the pointer, using its reported directory", async () => {
  vi.stubGlobal("devicePixelRatio", 2);
  await render(workspace(
    { type: "open", tabId: "drop-remote", pane: remote("drop-target") },
    { type: "split", pane: remote("drop-focused"), orientation: "horizontal" },
  ));
  await sendTerminalMessage({ cwd: "/srv/target directory" });
  await sendTerminalMessage({ cwd: "/srv/focused" }, "remote_terminal_open", 1);
  const paths = ["/tmp/first file.txt", "/tmp/second.txt"];

  await dropFiles("#pane-drop-target > div", paths);

  expect(dialog()).toBeNull();
  expect(uploads()).toEqual([["transfers_upload", {
    host: { id: host.id, name: host.name }, paths, remoteDir: "/srv/target directory",
  }]]);
});

it("asks where to upload when the Terminal has no directory report, and respects each answer", async () => {
  panelListings.set(host.id, { path: "/srv/panel", entries: [] });
  await render(workspace({ type: "open", tabId: "unknown-directory", pane: remote("unknown-directory") }));
  const paths = ["/tmp/file.txt"];
  const target = "#pane-unknown-directory > div";

  await dropFiles(target, paths);
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Choose an upload folder");
  expect(dialog()?.textContent).toContain("/srv/panel");
  expect(uploads()).toEqual([]);
  await clickButton("Cancel", dialog()!);
  expect(uploads()).toEqual([]);

  await dropFiles(target, paths);
  await clickButton("File panel folder", dialog()!);
  await dropFiles(target, paths);
  await clickButton("Home folder", dialog()!);
  expect(uploads().map(([, args]) => args)).toEqual([
    { host: { id: host.id, name: host.name }, paths, remoteDir: "/srv/panel" },
    { host: { id: host.id, name: host.name }, paths, remoteDir: "/home/deploy" },
  ]);
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("files_remote_home", { hostId: host.id });
});

it("continues to upload system files dropped directly in the File panel", async () => {
  panelListings.set(host.id, { path: "/srv/file-panel", entries: [] });
  await render(workspace({ type: "open", tabId: "file-panel-drop", pane: remote("file-panel-drop") }));
  const paths = ["/tmp/file.txt"];

  await dropFiles('#files [role="grid"]', paths);

  expect(dialog()).toBeNull();
  expect(uploads()).toEqual([["transfers_upload", {
    host: { id: host.id, name: host.name }, paths, remoteDir: "/srv/file-panel",
  }]]);
});

it("offers only the Home folder when the Terminal has no File panel folder", async () => {
  const other = { ...host, id: "drop-other-host", name: "Other Host" };
  panelListings.set(other.id, { path: "/srv/other-host", entries: [] });
  await render(workspace(
    { type: "open", tabId: "drop-other-panel", pane: remote("drop-no-panel") },
    { type: "split", pane: newPane({ kind: "remote-terminal", host: other }, "drop-other-panel"), orientation: "horizontal" },
  ));
  expect(document.querySelector('#files [role="grid"]')?.getAttribute("aria-label")).toBe("Files in /srv/other-host");

  await dropFiles("#pane-drop-no-panel > div", ["/tmp/file.txt"]);

  expect(dialog()?.textContent).toContain(host.name);
  expect(dialog()?.textContent).not.toContain("/srv/other-host");
  const options = [...dialog()!.querySelectorAll("button")];
  expect(options.find((option) => option.textContent === "File panel folder")?.disabled).toBe(true);
  expect(options.find((option) => option.textContent === "Home folder")?.disabled).toBe(false);
});

it("asks for a destination after reconnecting when the replacement shell has yet to report", async () => {
  await render(workspace({ type: "open", tabId: "drop-reconnected", pane: remote("drop-reconnected") }));
  await sendTerminalMessage({ cwd: "/srv/old-shell" });
  await sendTerminalMessage({ connection: { state: "reconnecting", attempt: 1, attempts: 3 } });
  await dropFiles("#pane-drop-reconnected > div", ["/tmp/file.txt"]);
  expect(dialog()).toBeNull();
  await sendTerminalMessage({ connection: { state: "connected" } });

  await dropFiles("#pane-drop-reconnected > div", ["/tmp/file.txt"]);

  expect(uploads()).toEqual([]);
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Choose an upload folder");
});

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

function contextMenuItem(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === label);
  expect(item, label).toBeDefined();
  return item!;
}

async function openedTerminalId(command: "remote_terminal_open" | "local_terminal_open") {
  const ipc = vi.mocked(invoke);
  const opened = ipc.mock.calls.findIndex(([name]) => name === command);
  const result = await ipc.mock.results[opened]?.value as number | { id: number };
  return typeof result === "number" ? result : result.id;
}

function openTerminalMenu(paneId: string) {
  return act(async () => document.querySelector(`#pane-${paneId} .xterm`)!.dispatchEvent(new MouseEvent("contextmenu", {
    button: 2, bubbles: true, cancelable: true,
  })));
}

async function selectTabMenu(tabId: string, label: string) {
  const tab = document.getElementById(`tab-${tabId}`)!;
  await act(async () => tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  await act(async () => contextMenuItem(label).click());
}

async function clickButton(label: string, scope: ParentNode = document) {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.getAttribute("aria-label") === label || button.textContent === label
    || [...(button.labels ?? [])].some((element) => element.textContent === label));
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

function offerUpdate(body?: string) {
  const update = new Update({ rid: 1, currentVersion: "1.2.2", version: "1.2.3", body, rawJson: {} });
  const downloadAndInstall = vi.spyOn(update, "downloadAndInstall").mockResolvedValue(undefined);
  vi.mocked(check).mockResolvedValue(update);
  return downloadAndInstall;
}

async function showUpdateNotice(...actions: TabsAction[]) {
  await render(workspace(...actions));
  await act(async () => updatesStore.getState().check("manual"));
}

it("opens the update dialog from the status bar and keeps the offer after Later", async () => {
  const downloadAndInstall = offerUpdate();
  await showUpdateNotice();
  const notice = "SSH Astra 1.2.3 is available";

  expect(dialog()).toBeNull();
  await clickButton(notice);
  expect(dialog()?.querySelector("h2")?.textContent).toBe(notice);
  expect(dialog()?.textContent).toContain("No release notes are available for this version.");
  expect(document.activeElement?.textContent).toBe("Later");
  expect(downloadAndInstall).not.toHaveBeenCalled();

  await clickButton("Later", dialog()!);
  expect(dialog()).toBeNull();
  expect(downloadAndInstall).not.toHaveBeenCalled();

  await clickButton(notice);
  await act(async () => i18n.changeLanguage("zh"));
  expect(dialog()?.querySelector("h2")?.textContent).toBe("SSH Astra 1.2.3 已发布");
  expect(dialog()?.textContent).toContain("0 个连接");
  await clickButton("更新并重启", dialog()!);
  expect(dialog()).toBeNull();
  expect(downloadAndInstall).toHaveBeenCalledTimes(1);
  expect(relaunch).toHaveBeenCalledTimes(1);
});

it("counts live Connections, unfinished transfers, and running Port forwards before restarting", async () => {
  enableDesktopWindow();
  offerUpdate();
  const rule = (id: string, bindPort: number): PortForward => ({
    id, bindPort, type: "dynamic", bindAddress: "localhost", label: id, autoStart: false,
  });
  const withForward = { ...host, forwards: [rule("one", 2201)] };
  const forwardOnly = { ...host, id: "forward-only", name: "Forward only", forwards: [rule("two", 2202), rule("failed", 2203)] };
  const heldOnly = { ...host, id: "held-only", name: "Held only" };
  savedHosts = [withForward, forwardOnly, heldOnly];
  await hostsStore.getState().load();
  initialHeld = [host.id, heldOnly.id];
  initialForwards = [
    { hostId: host.id, forwardId: "one", status: { state: "running" } },
    { hostId: forwardOnly.id, forwardId: "two", status: { state: "running" } },
    { hostId: forwardOnly.id, forwardId: "failed", status: { state: "failed", reason: "Unavailable" } },
  ];

  const states: Transfer["state"][] = [
    { type: "running" }, { type: "queued" }, { type: "paused" },
    { type: "done" }, { type: "failed", message: "Unavailable" }, { type: "cancelled" },
  ];
  initialTransfers = states.map((state, index) => ({
    id: index + 1, state, direction: "download", name: `file-${index}`, source: "/srv/file", target: "/tmp/file",
    bytesDone: 0, bytesTotal: 2, filesDone: 0, filesTotal: 1, unprotected: false,
  }));

  await showUpdateNotice(
    { type: "open", tabId: "remote-one", pane: remote("remote-one") },
    { type: "open", tabId: "remote-two", pane: remote("remote-two") },
    { type: "open", tabId: "local", pane: local("local") },
  );
  await sendTerminalMessage({ connection: { state: "connected" } });
  await sendTerminalMessage({ connection: { state: "connected" } }, "remote_terminal_open", 1);
  await clickButton("SSH Astra 1.2.3 is available");
  const activity = () => [...dialog()!.querySelectorAll("li")].map((item) => item.textContent);
  expect(activity()).toEqual(["3 Connections", "3 transfers", "2 Port forwards"]);

  const watch = vi.mocked(invoke).mock.calls.find(([command]) => command === "forwards_watch")?.[1] as {
    onEvent: { onmessage(event: ForwardEvent): void };
  };
  await act(async () => watch.onEvent.onmessage({ hostId: forwardOnly.id, forwardId: "two", status: { state: "stopped" } }));
  expect(activity()).toEqual(["2 Connections", "3 transfers", "1 Port forward"]);

  await clickButton("Later", dialog()!);
  await requestWindowClose();
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Quit SSH Astra?");
  expect(activity()).toEqual(["2 Connections", "3 transfers", "1 Port forward"]);

  await act(async () => i18n.changeLanguage("zh"));
  expect(dialog()?.querySelector("h2")?.textContent).toBe("退出 SSH Astra？");
  expect(activity()).toEqual(["2 个连接", "3 项传输", "1 个端口转发"]);
});

it("renders release notes as Markdown with HTML, scripts, images, and unsafe links removed", async () => {
  offerUpdate([
    "## Improvements",
    "",
    "- **Faster** reconnects and `ssh-astra` fixes",
    "- [Read more](https://example.invalid/release)",
    "",
    "A <span data-release-html=\"fixture\">plain detail</span> remains readable.",
    "",
    "<script type=\"application/x-release-notes-fixture\">script fixture</script>",
    "",
    "<div data-release-html=\"fixture\">raw HTML block</div>",
    "",
    "<img src=\"https://example.invalid/html-image.png\" alt=\"HTML preview\">",
    "",
    "![Remote preview](https://example.invalid/markdown-image.png)",
    "",
    "[Script URL](javascript:fixture) [Inline data](data:text/plain,fixture) [Local path](file:///tmp/fixture)",
    "[Relative](./readme) [No scheme](//example.invalid/path)",
  ].join("\n"));
  await showUpdateNotice();
  await clickButton("SSH Astra 1.2.3 is available");

  const update = dialog()!;
  expect([...update.querySelectorAll("h2")].map((heading) => heading.textContent)).toContain("Improvements");
  expect(update.querySelector("li strong")?.textContent).toBe("Faster");
  expect(update.querySelector("li code")?.textContent).toBe("ssh-astra");
  expect(update.textContent).toContain("A plain detail remains readable.");
  expect(update.querySelector("script, img, [data-release-html]")).toBeNull();
  for (const stripped of ["script fixture", "raw HTML block", "HTML preview", "Remote preview", "<span"]) {
    expect(update.textContent).not.toContain(stripped);
  }
  const links = update.querySelectorAll<HTMLAnchorElement>("a");
  expect(Array.from(links, (link) => link.href)).toEqual(["https://example.invalid/release"]);
  expect(openUrl).not.toHaveBeenCalled();
  await act(async () => links[0]!.click());
  expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://example.invalid/release");
});

it("records a replacement in Settings and uses it in the window and command palette after reopening", async () => {
  const initial = workspace({ type: "open", tabId: "settings", pane: newPane({ kind: "settings" }, "settings") });
  const mac = currentPlatform() === "mac";
  const mods = mac ? { metaKey: true } : { ctrlKey: true, shiftKey: true };
  async function press(key: string, code: string, modifiers: KeyboardEventInit = mods, target = document.activeElement ?? document.body) {
    const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...modifiers });
    await act(async () => target.dispatchEvent(event));
    return event.defaultPrevented;
  }

  await render(initial);
  await clickButton("Shortcuts");
  await clickButton("Edit shortcut for New Local terminal");
  expect(await press("j", "KeyJ", {}, document.body)).toBe(false);
  expect(await press("Escape", "Escape", {})).toBe(true);
  expect(settingsFile.shortcuts).toBeUndefined();
  await clickButton("Edit shortcut for New Local terminal");
  if (!mac) {
    expect(await press("w", "KeyW", { ctrlKey: true })).toBe(true);
    expect(document.body.textContent).toContain("Ctrl + letter combinations are reserved for the Terminal shell");
    expect(settingsFile.shortcuts).toBeUndefined();
  }
  expect(await press("w", "KeyW")).toBe(true);
  expect(document.body.textContent).toContain("already used by Close pane");
  expect(tabIds()).toEqual(["tab-settings"]);
  expect(settingsFile.shortcuts).toBeUndefined();
  await clickButton("Replace shortcut");
  expect(settingsFile.shortcuts).toMatchObject({ newTab: { code: "KeyW" }, closePane: null });

  await unmount();
  await startSettings(settingsBackend);
  await render(initial);
  await press("k", "KeyK");
  const newTerminal = [...(dialog()?.querySelectorAll('[role="option"]') ?? [])]
    .find((option) => option.textContent?.includes("New Local terminal"));
  expect(newTerminal?.textContent).toContain(mac ? "⌘W" : "Ctrl+Shift+W");
  await press("k", "KeyK");

  expect(await press("t", "KeyT")).toBe(false);
  expect(await press("w", "KeyW")).toBe(true);
  expect(tabIds()).toHaveLength(2);
  await act(async () => document.getElementById("tab-settings")!.click());
  await clickButton("Shortcuts");
  await clickButton("Reset shortcut for New Local terminal");
  expect(settingsFile.shortcuts).toEqual({ closePane: null });
  await clickButton("Reset all shortcuts");
  expect(settingsFile.shortcuts).toEqual({});
});

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

it.each([
  ["Split right", "width", "25%", "50%"],
  ["Split down", "height", "50%", "100%"],
] as const)("applies %s to the clicked Terminal pane using its Host and working directory", async (label, axis, clickedSize, siblingSize) => {
  renderTerminalMenu = true;
  await render(workspace(
    { type: "open", tabId: "work", pane: remote("clicked") },
    { type: "split", orientation: "horizontal", pane: local("sibling") },
  ));
  await sendTerminalMessage({ cwd: "/srv/clicked" });
  const clicked = document.getElementById("pane-clicked")!;
  const sibling = document.getElementById("pane-sibling")!;
  expect(document.activeElement?.closest("#pane-sibling")).toBe(sibling);
  await openTerminalMenu("clicked");
  await act(async () => contextMenuItem(label).click());
  expect(clicked.style[axis]).toBe(clickedSize);
  expect(sibling.style[axis]).toBe(siblingSize);
  const remoteOpens = vi.mocked(invoke).mock.calls.filter(([command]) => command === "remote_terminal_open");
  expect(remoteOpens).toHaveLength(2);
  expect(remoteOpens[1]?.[1]).toMatchObject({ hostId: host.id, cwd: "/srv/clicked" });
  await vi.waitFor(() => {
    const activePane = document.querySelector('[data-pane-focus]')?.parentElement;
    expect(activePane).toBeTruthy();
    expect(activePane).not.toBe(clicked);
    expect(activePane?.querySelector("textarea")).toBe(document.activeElement);
  });
});

it("offers only the clicked Host's Snippets and runs one in that Terminal after prompting", async () => {
  renderTerminalMenu = true;
  snippetLibrary = [
    { id: "a", name: "Show files", command: "ls", group: null, hostIds: [], sendEnter: true },
    { id: "b", name: "Choose folder", command: "cd ${path:/srv}", group: null, hostIds: [host.id], sendEnter: true },
    { id: "c", name: "Check services", command: "systemctl status", group: null, hostIds: ["other-host"], sendEnter: true },
  ];
  await render(workspace(
    { type: "open", tabId: "work", pane: remote("clicked") },
    { type: "split", orientation: "horizontal", pane: local("sibling") },
  ));
  const ipc = vi.mocked(invoke);
  const remoteId = await openedTerminalId("remote_terminal_open");
  const writes = () => ipc.mock.calls.filter(([command]) => command === "terminal_write");

  await openTerminalMenu("clicked");
  const snippets = contextMenuItem("Snippets");
  await act(async () => {
    snippets.focus();
    snippets.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  });
  contextMenuItem("Show files");
  expect([...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === "Check services")).toBe(false);
  await act(async () => contextMenuItem("Choose folder").click());
  expect(writes()).toEqual([]);
  expect(document.activeElement).toBe(dialog()?.querySelector("input"));
  await clickButton("Run", dialog()!);
  expect(writes()).toEqual([["terminal_write", { id: remoteId, data: "cd /srv\r" }]]);
  await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector("#pane-clicked textarea")));
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

it("opens the configured default Local terminal shell and reports a missing selection", async () => {
  await render(workspace({ type: "open", tabId: "settings", pane: newPane({ kind: "settings" }, "settings-pane") }));
  await clickButton("Terminal");
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Default local shell"]')!;
  expect([...select.options].map((option) => option.textContent)).toEqual(["System default", "/bin/zsh", "/bin/bash"]);
  await act(async () => {
    select.value = "/bin/zsh";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(settingsFile.terminal).toMatchObject({ localShell: "/bin/zsh" });
  await clickButton("New Local terminal");
  expect(vi.mocked(invoke).mock.calls.find(([command]) => command === "local_terminal_open")?.[1])
    .toMatchObject({ shellId: "/bin/zsh" });

  await sendTerminalMessage({ localShellFallback: true }, "local_terminal_open");
  expect([...document.querySelectorAll('[role="status"]')].map((item) => item.textContent))
    .toContain("The selected shell is unavailable. Using the system default shell.");
});

it("opens a one-off shell from the tab strip and preserves it through split and restore", async () => {
  settingsFile.terminal = { localShell: "/bin/zsh" };
  await startSettings(settingsBackend);
  await render(emptyTabs);
  const chooser = document.querySelector('[aria-label="Choose a Local terminal shell"]')!;
  await act(async () => chooser.dispatchEvent(new KeyboardEvent("keydown", {
    key: "ArrowDown", bubbles: true, cancelable: true,
  })));
  await act(async () => contextMenuItem("/bin/bash").click());
  const localOpens = () => vi.mocked(invoke).mock.calls
    .filter(([command]) => command === "local_terminal_open")
    .map(([, args]) => args as { shellId?: string; cwd?: string });
  expect(localOpens()[0]).toMatchObject({ shellId: "/bin/bash" });
  expect(settingsFile.terminal).toMatchObject({ localShell: "/bin/zsh" });

  const cwd = "/tmp/it's here";
  await sendTerminalMessage({ cwd }, "local_terminal_open");
  await clickButton("Split right");
  expect(localOpens()[1]).toMatchObject({ shellId: "/bin/bash", cwd });

  await unmount();
  await startSettings(settingsBackend);
  await render(restoreWorkspaceLayout(getSetting(workspaceLayoutSetting), [], "layout"));
  expect(localOpens().slice(2)).toMatchObject([
    { shellId: "/bin/bash", cwd },
    { shellId: "/bin/bash", cwd },
  ]);
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
  ["disconnected", { connection: { state: "disconnected", reason: "Connection closed", reportReconnectFailure: false } }],
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

it("confirms app quit for a shared Connection even after opting out of Terminal close confirmation", async () => {
  enableDesktopWindow();
  settingsFile.workspacePreferences = { restoreTabs: "none", confirmClose: false };
  await startSettings(settingsBackend);
  await render(workspace(
    { type: "open", tabId: "work", pane: remote("first") },
    { type: "split", pane: remote("second"), orientation: "horizontal" },
  ));

  await requestWindowClose();
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Quit SSH Astra?");
  expect([...dialog()!.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
    "1 Connection", "0 transfers", "0 Port forwards",
  ]);
  expect(document.activeElement?.textContent).toBe("Cancel");
  expect(windowDestroys()).toHaveLength(0);

  await requestWindowClose();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await clickButton("Cancel", dialog()!);
  expect(windowDestroys()).toHaveLength(0);

  await requestWindowClose();
  await clickButton("Quit", dialog()!);
  expect(windowDestroys()).toHaveLength(1);
});

it("quits without asking when the workspace is idle", async () => {
  enableDesktopWindow();
  await render(workspace({ type: "open", tabId: "local", pane: local("local") }));

  await requestWindowClose();
  expect(dialog()).toBeNull();
  expect(windowDestroys()).toHaveLength(1);
});

it("confirms quit when a transfer or File panel is the last holder of a Connection", async () => {
  enableDesktopWindow();
  liveConnectionCount = 1;
  await render(workspace());

  await requestWindowClose();
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Quit SSH Astra?");
  expect(dialog()?.querySelector("li")?.textContent).toBe("1 Connection");
  expect(windowDestroys()).toHaveLength(0);
});

it("saves a separate quit preference and applies it while a Connection is open", async () => {
  enableDesktopWindow();
  await render(workspace({ type: "open", tabId: "work", pane: remote("remote") }));
  await clickButton("Settings");

  const setting = document.querySelector('[role="radiogroup"][aria-label="Confirm app quit"]');
  expect(setting?.querySelector('[aria-checked="true"]')?.textContent).toBe("On");
  await clickButton("Off", setting!);
  expect(settingsFile.workspacePreferences).toMatchObject({ confirmClose: true, confirmQuit: false });

  await requestWindowClose();
  expect(dialog()).toBeNull();
  expect(windowDestroys()).toHaveLength(1);
});

async function broadcastShortcut(inWindow = false) {
  const modifiers = currentPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true };
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "B", code: "KeyB", bubbles: true, cancelable: true, shiftKey: true, altKey: inWindow, ...modifiers,
  })));
}

const broadcastMarks = () => [...document.querySelectorAll("[data-broadcast-recipient]")].map((mark) => mark.parentElement?.id);

it("pastes a literal path only into the Local terminal under the pointer, even with Broadcast enabled", async () => {
  localShellPrograms.set("/bin/bash", "fish");
  await render(workspace(
    { type: "open", tabId: "local-drop", pane: newPane({ kind: "local-terminal", shellId: "/bin/bash" }, "local-drop") },
    { type: "split", pane: local("focused-local-drop"), orientation: "horizontal" },
  ));
  const id = await openedTerminalId("local_terminal_open");
  await broadcastShortcut();
  expect(broadcastMarks()).toEqual(["pane-local-drop", "pane-focused-local-drop"]);

  await dropFiles("#pane-local-drop > div", ["/tmp/it's a file.txt"]);

  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "terminal_write"))
    .toEqual([["terminal_write", { id, data: "'/tmp/it\\'s a file.txt'" }]]);
});

it("uses the running WSL distribution's translated paths and shell", async () => {
  const pane = newPane({ kind: "local-terminal", shellId: "wsl:Ubuntu" }, "wsl-drop");
  await render(workspace({ type: "open", tabId: "wsl-drop", pane }));
  const id = await openedTerminalId("local_terminal_open");
  const paths = [String.raw`C:\some folder\it's.txt`];

  await dropFiles("#pane-wsl-drop > div", paths);

  expect(vi.mocked(invoke)).toHaveBeenCalledWith("local_terminal_wsl_paths", { distribution: "Ubuntu", paths });
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "terminal_write"))
    .toEqual([["terminal_write", { id, data: "'/custom/c/some folder/it\\'s.txt'" }]]);
});

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

const homeSearch = () => document.querySelector<HTMLInputElement>('input[aria-label="Search Hosts by name, address, user or Tag"]')!;
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

it("filters the Host list and Home by Tag and keeps the selection when narrowing by search", async () => {
  savedHosts = [
    { ...host, name: "Production Gateway", tags: ["East Coast"] },
    { ...host, id: "backup", name: "Backup Node", tags: ["east coast", "24"] },
    { ...host, id: "west", name: "Development Gateway", tags: ["West Coast"] },
  ];
  await hostsStore.getState().load();
  await render(workspace({ type: "open", tabId: "home", pane: newPane({ kind: "home" }) }));

  const sidebar = document.querySelector<HTMLElement>('section[aria-label="Hosts"]')!;
  const home = document.querySelector<HTMLElement>("#tabpanel-home")!;
  for (const section of [sidebar, home]) {
    expect(section.querySelector('[role="group"][aria-label="Filter Hosts by Tag"]')).not.toBeNull();
    await clickButton("East Coast", section);
    expect(section.textContent).toContain("Production Gateway");
    expect(section.textContent).toContain("Backup Node");
    expect(section.textContent).not.toContain("Development Gateway");

    await search(section.querySelector<HTMLInputElement>('input[type="search"]')!, "tag:24");
    expect(section.textContent).not.toContain("Production Gateway");
    expect(section.textContent).toContain("Backup Node");
    expect(section.textContent).not.toContain("Connect to tag:24");

    await search(section.querySelector<HTMLInputElement>('input[type="search"]')!, "");
    await clickButton("All Tags", section);
    expect(section.textContent).toContain("Development Gateway");
  }

  await openPalette();
  await search(paletteSearch(), "tag:24");
  expect(paletteOptions().map((option) => option.textContent)).toEqual([expect.stringContaining("Backup Node")]);
});

it("switches Home layouts with the keyboard and restores the choice after restarting", async () => {
  savedHosts = [host];
  await hostsStore.getState().load();
  const tabs = workspace({ type: "open", tabId: "home", pane: newPane({ kind: "home" }) });
  const selectedLayout = () => document.querySelector('[aria-label="Home layout"] [aria-checked="true"]')?.textContent;
  await render(tabs);
  expect(selectedLayout()).toBe("Cards");

  const cards = document.querySelector<HTMLButtonElement>('[aria-label="Home layout"] [aria-checked="true"]')!;
  cards.focus();
  await act(async () => cards.dispatchEvent(new KeyboardEvent("keydown", {
    key: "ArrowRight", bubbles: true, cancelable: true,
  })));
  expect(selectedLayout()).toBe("List");
  expect(document.activeElement?.textContent).toBe("List");

  await unmount();
  await startSettings(settingsBackend);
  await render(tabs);
  expect(selectedLayout()).toBe("List");

  const cardOption = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Home layout"] [role="radio"]')]
    .find((option) => option.textContent === "Cards")!;
  await act(async () => cardOption.click());
  expect(selectedLayout()).toBe("Cards");
});

it("shows Host details in Home list rows and opens the exact match from search", async () => {
  const gateway: Host = { ...host, name: "Edge Gateway", icon: "ubuntu", color: "magenta", port: 2222, tags: ["West Coast", "Production"] };
  const archive = { ...host, id: "archive", name: "Archive" };
  savedHosts = [gateway, archive];
  initialHeld = [gateway.id];
  settingsFile.recentHosts = { [gateway.id]: { openedAt: 1 } };
  await startSettings(settingsBackend);
  await hostsStore.getState().load();
  await render(workspace({ type: "open", tabId: "home", pane: newPane({ kind: "home" }) }));

  const home = document.querySelector("#tabpanel-home")!;
  const hostButton = (scope: ParentNode, name: string) =>
    [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(name))!;
  const recent = home.querySelector('[aria-labelledby="home-recent"]')!;
  const group = home.querySelector('[aria-labelledby="home-group-ungrouped"]')!;
  const gatewayButton = hostButton(group, gateway.name);
  gatewayButton.focus();
  await clickButton("List", home);
  expect(document.activeElement).toBe(gatewayButton);
  for (const scope of [group, recent]) {
    const row = hostButton(scope, gateway.name);
    expect(row.querySelector('[data-host-icon="ubuntu"]')).not.toBeNull();
    expect(row.querySelector(".bg-ansi-magenta")).not.toBeNull();
    expect(row.textContent).toContain("deploy@example.com:2222");
    expect(row.textContent).toContain("West Coast");
    expect(row.textContent).toContain("Production");
    expect(row.textContent).toContain("Connected");
  }
  expect(hostButton(group, archive.name).textContent).toContain("Disconnected");

  await search(homeSearch(), gateway.name.toUpperCase());
  expect(hostButton(home, gateway.name).textContent).toContain("West Coast");
  await clickButton("Privacy mode");
  expect(hostButton(home, gateway.name).outerHTML).not.toContain(gateway.address);
  expect(hostButton(home, gateway.name).outerHTML).not.toContain(gateway.user);
  await enter(homeSearch());
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("remote_terminal_open", expect.objectContaining({ hostId: gateway.id }));
});

it("shows the same manual or detected icon in the Host list, Home and an open Terminal tab", async () => {
  savedHosts = [{ ...host, icon: "ubuntu", color: "cyan" }];
  await hostsStore.getState().load();
  await render(workspace(
    { type: "open", tabId: "work", pane: remote("work") },
    { type: "open", tabId: "home", pane: newPane({ kind: "home" }, "home") },
  ));
  const surfaces = [
    document.querySelector('section[aria-label="Hosts"]'),
    document.querySelector("#tabpanel-home"),
    document.querySelector("#tab-work"),
  ];
  const glyphs = () => surfaces.map((surface) => surface?.querySelector("[data-host-icon]"));
  expect(glyphs().map((glyph) => glyph?.getAttribute("data-host-icon"))).toEqual(["ubuntu", "ubuntu", "ubuntu"]);
  expect(glyphs().every((glyph) => glyph?.classList.contains("bg-ansi-cyan/15"))).toBe(true);
  const tabChrome = document.querySelector("#tab-work")!.parentElement!;
  expect(tabChrome.querySelector(".bg-ansi-cyan")).not.toBeNull();

  const watch = vi.mocked(invoke).mock.calls.filter(([command]) => command === "host_tree_watch").at(-1)?.[1] as {
    onOsChange: { onmessage(event: HostOsChange): void };
  };
  act(() => watch.onOsChange.onmessage({ hostId: host.id, detectedOs: "debian" }));
  expect(glyphs().map((glyph) => glyph?.getAttribute("data-host-icon"))).toEqual(["ubuntu", "ubuntu", "ubuntu"]);

  const terminals = [...testTerminals];
  await act(async () => { await hostsStore.getState().saveHost({ ...host, icon: "database", color: "yellow" }, host.id); });
  expect(glyphs().map((glyph) => glyph?.getAttribute("data-host-icon"))).toEqual(["database", "database", "database"]);
  expect(glyphs().every((glyph) => glyph?.querySelector("svg"))).toBe(true);
  expect(glyphs().every((glyph) => glyph?.classList.contains("bg-ansi-yellow/15"))).toBe(true);
  expect(tabChrome.querySelector(".bg-ansi-yellow")).not.toBeNull();

  await act(async () => { await hostsStore.getState().saveHost(host, host.id); });
  expect(glyphs().map((glyph) => glyph?.getAttribute("data-host-icon"))).toEqual(["debian", "debian", "debian"]);
  act(() => watch.onOsChange.onmessage({ hostId: host.id, detectedOs: null }));
  expect(glyphs()).toEqual([null, null, null]);
  expect([...testTerminals]).toEqual(terminals);
  expect(terminalCloses()).toHaveLength(0);
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

it("searches eligible Snippets in the command palette and prompts before sending to the focused Terminal", async () => {
  const snippet = {
    id: "logs", name: "Find logs", command: "ls ${path:/var/log}", group: "Production tools", hostIds: [host.id], sendEnter: true,
  };
  snippetLibrary = [snippet, { ...snippet, id: "other", name: "Other logs", hostIds: ["other-host"] }];
  await render(workspace({ type: "open", tabId: "work", pane: remote("shell") }));
  await openPalette();
  await search(paletteSearch(), "Production tools");
  expect(paletteOptions().map((option) => option.textContent)).toEqual(["Run Find logs"]);

  await enter(paletteSearch());
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Run Find logs");
  expect(invoke).not.toHaveBeenCalledWith("terminal_write", expect.anything());
  const input = dialog()!.querySelector("input")!;
  expect(input.value).toBe("/var/log");
  await search(input, "/tmp/logs");
  await act(async () => dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(invoke).toHaveBeenCalledWith("terminal_write", { id: expect.any(Number), data: "ls /tmp/logs\r" });
});

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
    expect(tab.querySelector(":scope > span:not([aria-hidden])")?.textContent).toBe(host.name);
    expect(tab.getAttribute("aria-label")).toContain(host.name);
    expect(tab.title).toContain(host.name);
  }

  for (const input of [document.querySelector<HTMLInputElement>('input[aria-label="Search Hosts"]')!, homeSearch()]) {
    await search(input, host.address);
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
    .find((button) => button.textContent === "Import Hosts…")!;
  await act(async () => importButton.click());
  expect(dialog()?.textContent).toContain("CSV file");
  const importConfig = [...dialog()!.querySelectorAll("button")]
    .find((button) => button.textContent === "Import ~/.ssh/config")!;
  await act(async () => importConfig.click());
  expect(invoke).toHaveBeenCalledWith("hosts_import_source", { source: { kind: "sshConfig" } });
  expect(dialog()?.textContent).toContain("Imported Host");
  expect(dialog()?.textContent).toContain("Imported ProxyCommands");
  expect(dialog()?.querySelector("code")?.textContent).toBe('nc "%h" %p');
  expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent)
    .toBe("Imported 1, skipped 0, could not import 0.");
  await act(async () => dialog()!.querySelector("button")!.click());
  const dismiss = document.querySelector<HTMLButtonElement>('button[aria-label^="Dismiss notification: Imported"]');
  await act(async () => dismiss!.click());
});

it("keeps the import source picker on CSV cancellation and reports the selected file's outcomes", async () => {
  await render(workspace({ type: "open", tabId: "home", pane: newPane({ kind: "home" }) }));
  const importButton = [...document.querySelectorAll<HTMLButtonElement>("#tabpanel-home button")]
    .find((button) => button.textContent === "Import Hosts…")!;
  await act(async () => importButton.click());
  const chooseCsv = [...dialog()!.querySelectorAll("button")]
    .find((button) => button.textContent === "CSV file…")!;
  await act(async () => chooseCsv.click());
  expect(dialog()?.textContent).toContain("Choose where to import Hosts from.");
  expect(invoke).not.toHaveBeenCalledWith("hosts_import_source", expect.anything());

  importPath = "/fixtures/host-import.csv";
  await act(async () => chooseCsv.click());
  expect(openFileDialog).toHaveBeenCalledWith(expect.objectContaining({
    multiple: false, directory: false, filters: [{ name: "CSV file", extensions: ["csv"] }],
  }));
  expect(invoke).toHaveBeenCalledWith("hosts_import_source", { source: { kind: "csv", path: importPath } });
  expect(dialog()?.textContent).toContain("CSV import results");
  expect(dialog()?.textContent).toContain("CSV Host");
  expect(dialog()?.textContent).toContain("Existing Host");
  expect(dialog()?.textContent).toContain("Line 3: Port must be a whole number from 1 to 65535.");
  await act(async () => dialog()!.querySelector("button")!.click());
  const dismiss = document.querySelector<HTMLButtonElement>('button[aria-label^="Dismiss notification: Imported"]');
  await act(async () => dismiss!.click());
});

it("imports a selected PuTTY registry export through the shared report", async () => {
  await render(workspace({ type: "open", tabId: "home", pane: newPane({ kind: "home" }) }));
  const importButton = [...document.querySelectorAll<HTMLButtonElement>("#tabpanel-home button")]
    .find((button) => button.textContent === "Import Hosts…")!;
  await act(async () => importButton.click());
  const choosePutty = [...dialog()!.querySelectorAll("button")]
    .find((button) => button.textContent === "PuTTY registry export…");
  expect(choosePutty).toBeDefined();
  await act(async () => choosePutty!.click());
  expect(dialog()?.textContent).toContain("Choose where to import Hosts from.");
  expect(invoke).not.toHaveBeenCalledWith("hosts_import_source", expect.anything());

  importPath = "/fixtures/putty-sessions.reg";
  await act(async () => choosePutty!.click());
  expect(openFileDialog).toHaveBeenCalledWith(expect.objectContaining({
    multiple: false, directory: false, filters: [{ name: "PuTTY registry export", extensions: ["reg"] }],
  }));
  expect(invoke).toHaveBeenCalledWith("hosts_import_source", { source: { kind: "putty", path: importPath } });
  expect(dialog()?.textContent).toContain("PuTTY import results");
  expect(dialog()?.textContent).toContain("Staging server");
  expect(dialog()?.textContent).toContain("Saved credentials were omitted.");
  expect(dialog()?.querySelector("code")).toBeNull();
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

it("starts a Terminal log from its tab menu and stops it from the command palette", async () => {
  await render(workspace({ type: "open", tabId: "log", pane: local("log-pane") }));
  const tab = document.getElementById("tab-log")!;
  expect(tab.getAttribute("aria-label")).not.toContain("Terminal log active");

  await selectTabMenu("log", "Start Terminal log");
  expect(invoke).toHaveBeenCalledWith("terminal_log_start", { id: expect.any(Number) });
  await sendTerminalMessage({ terminalLog: { state: "active" } }, "local_terminal_open");
  expect(tab.getAttribute("aria-label")).toContain("Terminal log active");

  await paletteAction("Stop Terminal log");
  expect(invoke).toHaveBeenCalledWith("terminal_log_stop", { id: expect.any(Number) });
  await sendTerminalMessage({ terminalLog: { state: "stopped" } }, "local_terminal_open");
  expect(tab.getAttribute("aria-label")).not.toContain("Terminal log active");
});

it("shows the Terminal log marker for an unfocused split even while its Host reconnects", async () => {
  await render(workspace(
    { type: "open", tabId: "log", pane: remote("logging-remote") },
    { type: "split", pane: local("focused-local"), orientation: "horizontal" },
  ));
  const tab = document.getElementById("tab-log")!;
  await sendTerminalMessage({ terminalLog: { state: "active" } });
  await sendTerminalMessage({ connection: { state: "reconnecting", attempt: 1, attempts: 3 } });
  expect(tab.getAttribute("aria-label")).toContain("Terminal log active");

  await sendTerminalMessage({ exitCode: 0 });
  expect(tab.getAttribute("aria-label")).not.toContain("Terminal log active");
});

it("starts and stops the Terminal log for the clicked split pane", async () => {
  renderTerminalMenu = true;
  await render(workspace(
    { type: "open", tabId: "log", pane: remote("clicked") },
    { type: "split", pane: local("sibling"), orientation: "horizontal" },
  ));
  const remoteId = await openedTerminalId("remote_terminal_open");
  await openTerminalMenu("clicked");
  await act(async () => contextMenuItem("Start Terminal log").click());
  expect(invoke).toHaveBeenCalledWith("terminal_log_start", { id: remoteId });
  await sendTerminalMessage({ terminalLog: { state: "active" } });
  await openTerminalMenu("clicked");
  await act(async () => contextMenuItem("Stop Terminal log").click());
  expect(invoke).toHaveBeenCalledWith("terminal_log_stop", { id: remoteId });
});

it("starts a Recording from the Terminal menu and stops it from the command palette independently of its log", async () => {
  renderTerminalMenu = true;
  await render(workspace({ type: "open", tabId: "recording", pane: local("recording-pane") }));
  const tab = document.getElementById("tab-recording")!;
  const terminal = document.querySelector('[aria-label="Local terminal"]')!;
  await act(async () => terminal.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 })));
  const start = [...document.querySelectorAll('[role="menuitem"]')]
    .find((item) => item.textContent === "Start Recording");
  expect(start).toBeDefined();
  await act(async () => (start as HTMLElement).click());
  expect(invoke).toHaveBeenCalledWith("terminal_recording_start", { id: expect.any(Number) });

  await sendTerminalMessage({ terminalLog: { state: "active" } }, "local_terminal_open");
  await sendTerminalMessage({ recording: { state: "active" } }, "local_terminal_open");
  expect(tab.getAttribute("aria-label")).toContain("Recording active");
  await paletteAction("Stop Recording");
  expect(invoke).toHaveBeenCalledWith("terminal_recording_stop", { id: expect.any(Number) });
  await sendTerminalMessage({ recording: { state: "stopped" } }, "local_terminal_open");

  expect(tab.getAttribute("aria-label")).not.toContain("Recording active");
  expect(tab.getAttribute("aria-label")).toContain("Terminal log active");
});
