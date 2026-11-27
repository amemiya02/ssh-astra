import { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { filesSetting } from "@/features/files/file-prefs";
import { fileBrowsers } from "@/features/files/fileBrowsers";
import { terminalCwds } from "@/features/files/terminalCwds";
import { BroadcastPaneContext, createBroadcast } from "@/features/workspace/broadcast";
import { startI18n } from "@/i18n";
import type { ConnectProgress } from "@/lib/ipc/connect";
import type { Host } from "@/lib/ipc/hosts";
import type { ConnectionState, ShellIntegrationEvent, TerminalMessage } from "@/lib/ipc/terminal";
import { setSetting, startSettings } from "@/lib/storage";
import { RemoteTerminalView } from "./RemoteTerminalView";
import { XtermView } from "./XtermView";
import { terminalSetting } from "./terminal-prefs";

vi.mock("./XtermView", () => ({ XtermView: vi.fn(() => null) }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    constructor(public onmessage: (message: T) => void) {}
  },
  invoke: vi.fn(async (command: string) => command === "remote_terminal_open" ? 7 : undefined),
  isTauri: () => true,
}));

const host: Host = {
  id: "prod",
  name: "Production",
  address: "prod.local",
  port: 22,
  user: "deploy",
  auth: { type: "password" },
  jumpHost: "jump",
  groupId: null,
  forwards: [],
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  startI18n();
});

beforeEach(() => vi.clearAllMocks());

it("follows the File panel only on its own ready Terminal, even with Broadcast enabled", async () => {
  await startSettings({ load: async () => ({}), save: async () => undefined });
  const paneId = "files-pane";
  const root = createRoot(document.createElement("div"));
  const terminal = new Terminal();
  const peerWrite = vi.fn();
  const broadcast = createBroadcast();
  broadcast.register("peer-tab", "peer-pane", peerWrite);
  broadcast.updateWorkspace(paneId, ["tab", "peer-tab"], [paneId, "peer-pane"]);
  broadcast.toggle("window", "tab");
  const ipc = vi.mocked(invoke);
  ipc.mockImplementation(async (command, args) => {
    if (command === "remote_terminal_open") return 7;
    if (command === "files_open") return 8;
    if (command === "files_list") {
      const { path } = args as { path: string };
      return { path: path === "" ? "/home/me" : path === "~/docs" ? "/home/me/docs" : path, entries: [] };
    }
  });
  const panel = fileBrowsers.get(paneId, host.id);
  const otherPanel = fileBrowsers.get("peer-pane", host.id);
  const hide = fileBrowsers.show(paneId, "connected");
  const hidePeer = fileBrowsers.show("peer-pane", "connected");
  let detach: (() => void) | undefined;

  try {
    act(() => root.render(
      <BroadcastPaneContext.Provider value={{ broadcast, tabId: "tab", paneId }}>
        <RemoteTerminalView paneId={paneId} host={host} onEditHost={() => {}} onClose={() => {}}
          onCwd={(path) => terminalCwds.report(paneId, path)} />
      </BroadcastPaneContext.Provider>,
    ));
    await act(async () => { detach = vi.mocked(XtermView).mock.calls[0]![0].attach(terminal); });
    const { onEvent } = ipc.mock.calls.find(([command]) => command === "remote_terminal_open")![1] as {
      onEvent: { onmessage: (message: TerminalMessage) => void };
    };
    const shell = (shellIntegration: ShellIntegrationEvent) => act(() => onEvent.onmessage({ shellIntegration }));
    const followCalls = () => ipc.mock.calls.filter(([command]) => command === "terminal_follow_file_directory");
    const navigate = (path: string) => act(async () => panel.getState().navigate(path));

    shell({ type: "availability", status: "available" });
    shell({ type: "promptStart", promptId: 1 });
    await navigate("/srv");
    expect(followCalls()).toEqual([]);

    act(() => setSetting(filesSetting, { ...filesSetting.defaults, terminalFollowsFilePanel: true }));
    await act(async () => otherPanel.getState().navigate("/other"));
    await navigate("~/docs");
    expect(followCalls()).toEqual([["terminal_follow_file_directory", { id: 7, promptId: 1, path: "/home/me/docs" }]]);
    expect(peerWrite).not.toHaveBeenCalled();
    await navigate("/soon-after");
    expect(followCalls()).toHaveLength(1);

    shell({ type: "commandStart", commandLine: null });
    await navigate("/busy");
    shell({ type: "commandEnd", exitCode: 0 });
    act(() => onEvent.onmessage({ cwd: "/home/me/docs" }));
    shell({ type: "promptStart", promptId: 2 });
    await act(async () => {});
    expect(panel.getState().path).toBe("/home/me/docs");
    expect(followCalls()).toHaveLength(1);

    act(() => terminal.input("unfinished draft", true));
    await navigate("/draft");
    expect(followCalls()).toHaveLength(1);

    act(() => onEvent.onmessage({ connection: { state: "reconnecting", attempt: 1, attempts: 3 } }));
    await navigate("/disconnected");
    act(() => onEvent.onmessage({ connection: { state: "connected" } }));
    shell({ type: "availability", status: "unsupported" });
    await navigate("/unsupported");
    shell({ type: "availability", status: "available" });
    shell({ type: "promptStart", promptId: 3 });
    act(() => setSetting(terminalSetting, { ...terminalSetting.defaults, shellIntegration: false }));
    await navigate("/disabled");
    expect(followCalls()).toHaveLength(1);
  } finally {
    act(() => {
      detach?.();
      terminal.dispose();
      root.unmount();
    });
    hide();
    hidePeer();
    fileBrowsers.retain(new Set());
    terminalCwds.retain(new Set());
    ipc.mockImplementation(async (command) => command === "remote_terminal_open" ? 7 : undefined);
  }
});

it("shows progress for each hop and keeps the failed attempt visible until Reconnect", async () => {
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const container = document.createElement("div");
  const root = createRoot(container);
  const terminal = new Terminal();
  act(() => root.render(<RemoteTerminalView paneId="pane" host={host} onEditHost={() => {}} onClose={() => {}} />));
  let detach: (() => void) | undefined;
  try {
    await act(async () => { detach = vi.mocked(XtermView).mock.calls[0]![0].attach(terminal); });
    const [, args] = vi.mocked(invoke).mock.calls.find(([command]) => command === "remote_terminal_open")!;
    const { onEvent, onPrompt } = args as {
      onEvent: { onmessage: (message: TerminalMessage) => void };
      onPrompt: { onmessage: (message: unknown) => void };
    };
    const connection = (state: ConnectionState) => act(() => {
      onEvent.onmessage({ connection: state });
      onPrompt.onmessage({ type: "reconnect", state });
    });
    const progress = (step: Partial<ConnectProgress>) => act(() => onPrompt.onmessage({
      type: "progress",
      progress: { elapsedMs: 0, method: null, stage: "reach", status: "running", ...step },
    }));
    const jump = { hostId: "jump", hostName: "Bastion", jumpHost: true };
    const target = { hostId: host.id, hostName: host.name, jumpHost: false };
    const jumpSteps = () => container.querySelector('ol[aria-label="Jump host: Bastion"]')?.textContent ?? "";
    const targetSteps = () => container.querySelector('ol[aria-label="Production"]')?.textContent ?? "";
    const reconnectButton = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Reconnect");

    connection({ state: "reconnecting", attempt: 1, attempts: 3 });
    expect(container.textContent).toContain("Reconnecting… try 1 of 3");
    progress(jump);
    expect(jumpSteps()).toContain("Reach serverIn progress");
    progress({ ...jump, status: "succeeded" });
    progress({ ...target, stage: "authenticate", method: "password", status: "failed" });
    expect(jumpSteps()).toContain("Reach serverComplete");
    expect(targetSteps()).toContain("Log in · passwordFailed");

    connection({ state: "reconnecting", attempt: 2, attempts: 3 });
    expect(container.textContent).toContain("Reconnecting… try 2 of 3");
    expect(jumpSteps()).toBe("");
    expect(targetSteps()).toContain("Log inPending");
    expect(reconnectButton()).toBeUndefined();

    progress({ ...jump, status: "failed" });
    connection({ state: "disconnected", reason: "Bastion is unreachable", reportReconnectFailure: true });
    expect(jumpSteps()).toContain("Reach serverFailed");
    expect(container.textContent).toContain("Bastion is unreachable");
    expect(invoke).toHaveBeenCalledWith("notification_show", {
      title: "Connection lost",
      body: "Could not reconnect to Production.",
    });
    act(() => reconnectButton()!.click());
    expect(invoke).toHaveBeenCalledWith("terminal_reconnect", { id: 7 });

    connection({ state: "reconnecting", attempt: 1, attempts: 1 });
    expect(jumpSteps()).toBe("");
    connection({ state: "connected" });
    expect(container.textContent).not.toContain("Disconnected");
  } finally {
    focus.mockRestore();
    act(() => {
      detach?.();
      terminal.dispose();
      root.unmount();
    });
  }
});

it("reports a long-running shell command only after that shell reports its exit status", async () => {
  await startSettings({
    load: async () => ({ notifications: { longCommandThresholdSeconds: 2 } }),
    save: async () => undefined,
  });
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
  const root = createRoot(document.createElement("div"));
  const terminal = new Terminal();
  act(() => root.render(<RemoteTerminalView paneId="pane" host={host} onEditHost={() => {}} onClose={() => {}} />));
  let detach: (() => void) | undefined;

  try {
    await act(async () => { detach = vi.mocked(XtermView).mock.calls[0]![0].attach(terminal); });
    const [, args] = vi.mocked(invoke).mock.calls.find(([command]) => command === "remote_terminal_open")!;
    const { onEvent } = args as { onEvent: { onmessage: (message: TerminalMessage) => void } };
    const emit = (message: TerminalMessage) => act(() => onEvent.onmessage(message));
    const shell = (shellIntegration: ShellIntegrationEvent) => emit({ shellIntegration });
    const notifications = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "notification_show");

    shell({ type: "availability", status: "available" });
    shell({ type: "commandStart", commandLine: "sleep 3; false" });
    clock.mockReturnValue(4_000);
    expect(notifications()).toEqual([]);
    shell({ type: "commandEnd", exitCode: 1 });
    expect(notifications()).toEqual([["notification_show", {
      title: "Command finished on Production",
      body: "sleep 3; false · Exit code 1",
    }]]);

    shell({ type: "commandStart", commandLine: "sleep 1" });
    clock.mockReturnValue(5_000);
    shell({ type: "commandEnd", exitCode: 0 });
    expect(notifications()).toHaveLength(1);

    shell({ type: "commandStart", commandLine: "sleep 4" });
    emit({ connection: { state: "reconnecting", attempt: 1, attempts: 3 } });
    emit({ connection: { state: "connected" } });
    shell({ type: "availability", status: "available" });
    clock.mockReturnValue(9_000);
    shell({ type: "commandEnd", exitCode: 0 });
    expect(notifications()).toHaveLength(1);

    shell({ type: "commandStart", commandLine: null });
    clock.mockReturnValue(12_000);
    shell({ type: "commandEnd", exitCode: 127 });
    expect(notifications().at(-1)).toEqual(["notification_show", {
      title: "Command finished on Production",
      body: "Exit code 127",
    }]);

    shell({ type: "commandStart", commandLine: "sleep 3" });
    clock.mockReturnValue(15_000);
    focus.mockReturnValue(true);
    shell({ type: "commandEnd", exitCode: 0 });
    expect(notifications()).toHaveLength(2);

    focus.mockReturnValue(false);
    shell({ type: "commandStart", commandLine: "exit" });
    clock.mockReturnValue(18_000);
    emit({ exitCode: 0 });
    expect(notifications()).toHaveLength(2);
  } finally {
    focus.mockRestore();
    clock.mockRestore();
    act(() => {
      detach?.();
      terminal.dispose();
      root.unmount();
    });
  }
});
