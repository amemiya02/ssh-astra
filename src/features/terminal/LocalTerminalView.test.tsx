import { Terminal } from "@xterm/xterm";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BroadcastPaneContext, createBroadcast } from "@/features/workspace/broadcast";
import { openLocalTerminal, saveClipboardImage, writeTerminal } from "@/lib/ipc/terminal";
import { LocalTerminalView } from "./LocalTerminalView";
import { XtermView } from "./XtermView";

vi.mock("./XtermView", () => ({ XtermView: vi.fn(() => null) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/ipc/terminal", () => ({
  openLocalTerminal: vi.fn(), writeTerminal: vi.fn(), resizeTerminal: vi.fn(), closeTerminal: vi.fn(), resolveWslPaths: vi.fn(),
  saveClipboardImage: vi.fn(),
}));

it("forwards the early ConPTY cursor reply and typed input when the local terminal opens", async () => {
  type Opened = Awaited<ReturnType<typeof openLocalTerminal>>;
  let finishOpening!: (terminal: Opened) => void;
  const opening = new Promise<Opened>((resolve) => { finishOpening = resolve; });
  vi.mocked(openLocalTerminal).mockReturnValue(opening);
  const root = createRoot(document.createElement("div"));
  const terminal = new Terminal();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  act(() => root.render(<LocalTerminalView />));
  const detach = vi.mocked(XtermView).mock.calls[0]![0].attach(terminal);
  try {
    const [, receive] = vi.mocked(openLocalTerminal).mock.calls[0]!;
    receive({ type: "output", data: new TextEncoder().encode("\x1b[6n") });
    // Drain xterm's parser while the backend still hasn't returned the terminal ID.
    await new Promise<void>((done) => terminal.write("", done));
    terminal.input("dir\r");
    expect(writeTerminal).not.toHaveBeenCalled();
    await act(async () => {
      finishOpening({ id: 7, shellProgram: "cmd.exe", wslDistribution: null });
      await opening;
    });
    expect(vi.mocked(writeTerminal).mock.calls).toEqual([[7, "\x1b[1;1Rdir\r"]]);
  } finally {
    detach();
    terminal.dispose();
    act(() => root.unmount());
  }
});

it("sends an explicit Snippet through the open local shell with its bracketed paste mode", async () => {
  vi.mocked(writeTerminal).mockClear();
  vi.mocked(openLocalTerminal).mockClear().mockResolvedValue({ id: 8, shellProgram: "bash", wslDistribution: null });
  const broadcast = createBroadcast();
  broadcast.updateWorkspace("pane", ["tab"], ["pane"]);
  const root = createRoot(document.createElement("div"));
  const terminal = new Terminal();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  act(() => root.render(
    <BroadcastPaneContext.Provider value={{ broadcast, tabId: "tab", paneId: "pane" }}>
      <LocalTerminalView />
    </BroadcastPaneContext.Provider>,
  ));
  const detach = vi.mocked(XtermView).mock.lastCall![0].attach(terminal);
  try {
    await act(async () => { await vi.mocked(openLocalTerminal).mock.results[0]!.value; });
    await new Promise<void>((resolve) => terminal.write("\x1b[?2004h", resolve));
    expect(writeTerminal).not.toHaveBeenCalled();
    await broadcast.captureInput("pane")!.send("echo one\necho two", false);
    expect(writeTerminal).toHaveBeenCalledExactlyOnceWith(8, "\x1b[200~echo one\recho two\x1b[201~");
  } finally {
    detach();
    terminal.dispose();
    act(() => root.unmount());
  }
});

it("pastes the private PNG path into the initiating Local terminal without submitting it", async () => {
  vi.mocked(writeTerminal).mockClear();
  vi.mocked(openLocalTerminal).mockResolvedValue({ id: 8, shellProgram: "bash", wslDistribution: null });
  vi.mocked(saveClipboardImage).mockResolvedValue("/tmp/Astra's images/image-example.png");
  const broadcast = createBroadcast();
  const peer = vi.fn();
  broadcast.register("other-tab", "peer", peer);
  broadcast.updateWorkspace("pane", ["tab", "other-tab"], ["pane", "peer"]);
  broadcast.toggle("window", "tab");
  const root = createRoot(document.createElement("div"));
  const terminal = new Terminal();
  act(() => root.render(
    <BroadcastPaneContext.Provider value={{ broadcast, tabId: "tab", paneId: "pane" }}>
      <LocalTerminalView />
    </BroadcastPaneContext.Provider>,
  ));
  const view = vi.mocked(XtermView).mock.lastCall![0];
  const detach = view.attach(terminal);
  try {
    await act(async () => {});
    await new Promise<void>((resolve) => terminal.write("\x1b[?2004h", resolve));
    await view.imagePasteRef!.current!();
    expect(saveClipboardImage).toHaveBeenCalledExactlyOnceWith(8);
    expect(writeTerminal).toHaveBeenCalledExactlyOnceWith(8, "\x1b[200~'/tmp/Astra'\\''s images/image-example.png'\x1b[201~");
    expect(peer).not.toHaveBeenCalled();
  } finally {
    detach();
    terminal.dispose();
    act(() => root.unmount());
  }
});
