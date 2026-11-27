import type { Terminal } from "@xterm/xterm";
import type { AgentScreenSnapshot } from "@/lib/ipc/terminal";

/** Copies rendered rows of the active buffer, keeping the screen ahead of scrollback in the byte budget. */
export function readAgentScreen(terminal: Terminal, scrollbackLines: number): AgentScreenSnapshot {
  const buffer = terminal.buffer.active;
  const encoder = new TextEncoder();
  // Match the native IPC budget before sending any rendered content across it.
  const bytes = new Uint8Array(64 * 1024);
  let remaining = bytes.length;
  let truncated = false;

  const readRows = (start: number, end: number, newestFirst = false): string => {
    const rows: string[] = [];
    for (let i = start; i < end; i++) {
      const separator = rows.length > 0 ? 1 : 0;
      if (remaining < separator) {
        truncated = true;
        break;
      }
      const row = newestFirst ? end - 1 - (i - start) : i;
      const text = buffer.getLine(row)?.translateToString(true).replace(/\p{Cc}/gu, "") ?? "";
      const { read, written } = encoder.encodeInto(text, bytes.subarray(0, remaining - separator));
      rows.push(text.slice(0, read));
      remaining -= separator + written;
      if (read < text.length) {
        truncated = true;
        break;
      }
    }
    return (newestFirst ? rows.reverse() : rows).join("\n");
  };

  const viewport = buffer.viewportY;
  const screen = readRows(viewport, viewport + terminal.rows);
  const scrollback = readRows(Math.max(0, viewport - scrollbackLines), viewport, true);
  return { screen, scrollback, truncated };
}
