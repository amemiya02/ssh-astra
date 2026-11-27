import { Terminal } from "@xterm/xterm";
import { expect, it } from "vitest";
import { watchTerminalNotifications } from "./terminal-notifications";

it("reads Terminal program notifications from the xterm output stream", async () => {
  const terminal = new Terminal({ allowProposedApi: true });
  const messages: string[] = [];
  const stop = watchTerminalNotifications(terminal, (body) => messages.push(body));
  const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
  try {
    await write("\x1b]9;Build");
    await write(" complete\x07\x1b]777;notify;Tests;Passed; 12 checks\x1b\\");
    await write("\x1b]777;other;Ignored;Ignored\x07");
    await write("\x1b]9;4;1;50\x07\x1b]9;9;/private/path\x07");
    await write("\x1b]9;  \x07");
    expect(messages).toEqual(["Build complete", "Tests\nPassed; 12 checks"]);
    stop();
    await write("\x1b]9;After detach\x07");
    expect(messages).toHaveLength(2);
  } finally {
    terminal.dispose();
  }
});
