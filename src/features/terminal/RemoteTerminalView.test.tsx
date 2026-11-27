import { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AgentReviewDialog } from "@/features/agent/AgentReviewDialog";
import { agentAccessSetting } from "@/features/agent/agent-access";
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
  invoke: vi.fn(async (command: string) => command === "remote_terminal_open" ? { id: 7, savedHost: true } : undefined),
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

it("returns the rendered viewport and recent scrollback through its own Terminal channel", async () => {
  const root = createRoot(document.createElement("div"));
  const terminal = new Terminal({ cols: 28, rows: 2, allowProposedApi: true });
  const ipc = vi.mocked(invoke);
  ipc.mockImplementation(async (command) => command === "remote_terminal_open" ? { id: 7, savedHost: true } : undefined);
  act(() => root.render(
    <RemoteTerminalView paneId="agent-pane" host={host} onEditHost={() => {}} onClose={() => {}} />,
  ));
  let detach: (() => void) | undefined;
  try {
    await act(async () => { detach = vi.mocked(XtermView).mock.lastCall![0].attach(terminal); });
    const { onEvent } = ipc.mock.calls.find(([command]) => command === "remote_terminal_open")![1] as {
      onEvent: { onmessage: (message: TerminalMessage) => void };
    };
    await new Promise<void>((resolve) => terminal.write(
      "older\r\nrecent\r\nold\x1b[2K\r\x1b[31mvisible\x1b[0m\r\nlast", resolve,
    ));
    act(() => onEvent.onmessage({ agentScreen: { requestId: 31, scrollbackLines: 1 } }));
    expect(ipc).toHaveBeenCalledWith("terminal_agent_screen", {
      requestId: 31, snapshot: { screen: "visible\nlast", scrollback: "recent", truncated: false },
    });
    terminal.scrollLines(-1);
    act(() => onEvent.onmessage({ agentScreen: { requestId: 32, scrollbackLines: 1 } }));
    expect(ipc).toHaveBeenCalledWith("terminal_agent_screen", {
      requestId: 32, snapshot: { screen: "recent\nvisible", scrollback: "older", truncated: false },
    });
    expect(ipc.mock.calls.filter(([command]) => command === "terminal_write")).toEqual([]);
  } finally {
    act(() => {
      detach?.();
      terminal.dispose();
      root.unmount();
    });
  }
});

it("reviews the exact pending command with a separate clipboard choice", async () => {
  const paneId = "review-pane";
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const terminal = new Terminal({ allowProposedApi: true });
  const ipc = vi.mocked(invoke);
  ipc.mockImplementation(async (command) => command === "remote_terminal_open" ? { id: 7, savedHost: true } : undefined);
  setSetting(agentAccessSetting, { enabled: true });
  act(() => root.render(<>
    <AgentReviewDialog />
    <RemoteTerminalView paneId={paneId} host={{ ...host, agentAccess: "approval" }} onEditHost={() => {}} onClose={() => {}} />
  </>));
  let detach: (() => void) | undefined;
  try {
    await act(async () => { detach = vi.mocked(XtermView).mock.lastCall![0].attach(terminal); });
    const { onEvent } = ipc.mock.calls.find(([command]) => command === "remote_terminal_open")![1] as {
      onEvent: { onmessage: (message: TerminalMessage) => void };
    };
    const request = { id: 31, terminalId: 7, host: "Production", promptId: 2, command: "  printf '%s' 'hello there'  " };
    act(() => onEvent.onmessage({ agentReview: request }));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(ipc).toHaveBeenCalledWith("terminal_agent_review_answer", { id: 31, choice: "unavailable" });

    act(() => {
      onEvent.onmessage({ shellIntegration: { type: "availability", status: "available" } });
      onEvent.onmessage({ shellIntegration: { type: "promptStart", promptId: 2 } });
      onEvent.onmessage({ agentReview: { ...request, id: 32 } });
    });
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Production");
    expect(dialog?.textContent).toContain("Terminal #7");
    expect(dialog?.querySelector("code")?.textContent).toBe(request.command);
    const copy = Array.from(dialog?.querySelectorAll("button") ?? []).find((button) => button.textContent === "Copy command");
    expect(copy).toBeDefined();
    act(() => copy?.click());
    expect(ipc).toHaveBeenCalledWith("terminal_agent_review_answer", { id: 32, choice: "copy" });
    expect(ipc.mock.calls.filter(([command]) => command === "terminal_write")).toEqual([]);

    act(() => {
      onEvent.onmessage({ agentReview: { ...request, id: 33 } });
      onEvent.onmessage({ shellIntegration: { type: "promptStart", promptId: 3 } });
    });
    expect(ipc).toHaveBeenCalledWith("terminal_agent_review_answer", { id: 33, choice: "unavailable" });
  } finally {
    act(() => {
      detach?.();
      terminal.dispose();
      root.unmount();
    });
    container.remove();
    setSetting(agentAccessSetting, { enabled: false });
  }
});

it("pastes an uploaded image only into the initiating Host and exact shell", async () => {
  const paneId = "image-pane";
  const root = createRoot(document.createElement("div"));
  const terminal = new Terminal();
  const peer = vi.fn();
  const broadcast = createBroadcast();
  broadcast.register("other-tab", "peer-pane", peer);
  broadcast.updateWorkspace(paneId, ["tab", "other-tab"], [paneId, "peer-pane"]);
  broadcast.toggle("window", "tab");
  const ipc = vi.mocked(invoke);
  let finishUpload!: (path: string) => void;
  const upload = new Promise<string>((resolve) => { finishUpload = resolve; });
  const uploaded = "/home/my user/.sshastra-clipboard/image-example.png";
  ipc.mockImplementation(async (command) => {
    if (command === "remote_terminal_open") return { id: 7, savedHost: true };
    if (command === "terminal_save_clipboard_image") return upload;
  });

  act(() => root.render(
    <BroadcastPaneContext.Provider value={{ broadcast, tabId: "tab", paneId }}>
      <RemoteTerminalView paneId={paneId} host={host} onEditHost={() => {}} onClose={() => {}} />
    </BroadcastPaneContext.Provider>,
  ));
  const view = vi.mocked(XtermView).mock.lastCall![0];
  let detach: (() => void) | undefined;
  try {
    await act(async () => { detach = view.attach(terminal); });
    const { onEvent } = ipc.mock.calls.find(([command]) => command === "remote_terminal_open")![1] as {
      onEvent: { onmessage: (message: TerminalMessage) => void };
    };
    const paste = view.imagePasteRef!.current!();
    expect(ipc).toHaveBeenCalledWith("terminal_save_clipboard_image", {
      id: 7, host: { id: "prod", name: "Production" }, generation: 0,
    });
    expect(ipc.mock.calls.filter(([command]) => command === "terminal_write")).toEqual([]);
    act(() => onEvent.onmessage({ connection: { state: "reconnecting", attempt: 1, attempts: 3 } }));
    act(() => onEvent.onmessage({ connection: { state: "connected" } }));
    finishUpload(uploaded);
    await paste;
    expect(ipc.mock.calls.filter(([command]) => command === "terminal_write")).toEqual([]);

    await view.imagePasteRef!.current!();
    expect(ipc.mock.calls.filter(([command]) => command === "terminal_write")).toEqual([
      ["terminal_write", { id: 7, data: `'${uploaded}'`, generation: 1 }],
    ]);
    expect(peer).not.toHaveBeenCalled();
  } finally {
    act(() => {
      detach?.();
      terminal.dispose();
      root.unmount();
    });
    ipc.mockImplementation(async (command) => command === "remote_terminal_open" ? { id: 7, savedHost: true } : undefined);
  }
});

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
    if (command === "remote_terminal_open") return { id: 7, savedHost: true };
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
    ipc.mockImplementation(async (command) => command === "remote_terminal_open" ? { id: 7, savedHost: true } : undefined);
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
