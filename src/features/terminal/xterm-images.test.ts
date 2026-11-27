import { Terminal } from "@xterm/xterm";
import { expect, it } from "vitest";
import { attachTerminalImages } from "./xterm-images";

it("changes image support without resetting the Terminal text or modes", async () => {
  const terminal = new Terminal({ allowProposedApi: true });
  const images = attachTerminalImages(terminal, true);
  const write = (data: string) => new Promise<void>((done) => terminal.write(data, done));
  const replies: string[] = [];
  const subscription = terminal.onData((reply) => replies.push(reply));
  try {
    await write("before \x1b[?2004h\x1b[c");
    expect(replies.pop()).toBe("\x1b[?62;4;9;22c");

    // A program can split a sequence across writes as the user toggles the setting.
    await write("\x1b]1337;File=inline=1;size=100:");
    images.setEnabled(false);
    await write("AAAA\x1b\\after\x1b[c");
    expect(replies.pop()).toBe("\x1b[?1;2c");
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("before after");
    expect(terminal.modes.bracketedPasteMode).toBe(true);

    images.setEnabled(true);
    await write("\x1b[c");
    expect(replies.pop()).toBe("\x1b[?62;4;9;22c");
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("before after");
  } finally {
    subscription.dispose();
    images.disposeTerminal();
  }
});
