import { Terminal } from "@xterm/xterm";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { openLocalTerminal, writeTerminal } from "@/lib/ipc/terminal";
import { LocalTerminalView } from "./LocalTerminalView";
import { XtermView } from "./XtermView";

vi.mock("./XtermView", () => ({ XtermView: vi.fn(() => null) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/ipc/terminal", () => ({
  openLocalTerminal: vi.fn(), writeTerminal: vi.fn(), resizeTerminal: vi.fn(), closeTerminal: vi.fn(),
}));

it("forwards the early ConPTY cursor reply and typed input when the local terminal opens", async () => {
  let finishOpening!: (id: number) => void;
  const opening = new Promise<number>((resolve) => { finishOpening = resolve; });
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
    finishOpening(7);
    await opening;
    expect(vi.mocked(writeTerminal).mock.calls).toEqual([[7, "\x1b[1;1Rdir\r"]]);
  } finally {
    detach();
    terminal.dispose();
    act(() => root.unmount());
  }
});
