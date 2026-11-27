import { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, expect, it, vi } from "vitest";
import { startI18n } from "@/i18n";
import type { ConnectProgress } from "@/lib/ipc/connect";
import type { Host } from "@/lib/ipc/hosts";
import type { ConnectionState, TerminalMessage } from "@/lib/ipc/terminal";
import { RemoteTerminalView } from "./RemoteTerminalView";
import { XtermView } from "./XtermView";

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
