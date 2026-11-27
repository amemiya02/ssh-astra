import { Terminal } from "@xterm/xterm";
import { expect, it } from "vitest";
import { readAgentScreen } from "./agent-screen";

it("keeps the viewport and newest scrollback within a UTF-8 byte budget", async () => {
  const terminal = new Terminal({ cols: 130, rows: 2, allowProposedApi: true });
  try {
    const history = Array.from({ length: 480 }, (_, i) => `${i}:${"界".repeat(62)}`);
    await new Promise<void>((resolve) => terminal.write([...history, "visible", "last"].join("\r\n"), resolve));
    const snapshot = readAgentScreen(terminal, 480);
    expect(snapshot.screen).toBe("visible\nlast");
    expect(snapshot.scrollback.endsWith(`\n${history.at(-1)}`)).toBe(true);
    expect(snapshot.scrollback).not.toContain(`\n${history[1]}\n`);
    expect(snapshot.scrollback).not.toContain("\uFFFD");
    expect(snapshot.truncated).toBe(true);
    expect(new TextEncoder().encode(snapshot.screen + snapshot.scrollback).length).toBeLessThanOrEqual(65_536);
  } finally {
    terminal.dispose();
  }
});

it("reads the alternate screen without including hidden normal-buffer text", async () => {
  const terminal = new Terminal({ cols: 25, rows: 2, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => terminal.write("normal\r\nscreen\r\nhistory\x1b[?1049h\x1b[Halternate", resolve));
    expect(readAgentScreen(terminal, 100)).toEqual({ screen: "alternate\n", scrollback: "", truncated: false });
  } finally {
    terminal.dispose();
  }
});
