import type { Terminal } from "@xterm/xterm";

/**
 * Test-only hooks for the E2E smoke test (`e2e/`), on `window.__sshastraE2E`.
 *
 * They exist only in a front end built with `VITE_E2E=1` (`pnpm e2e:build`):
 * elsewhere `e2eHooks` is `null` and the bundler drops every use of it. They
 * cover what WebDriver cannot reach: the native file picker, and a Terminal's
 * screen (xterm draws on a canvas).
 */
export interface E2eHooks {
  /** Answers queued for the next native "files to upload" pickers, oldest first. */
  pickedFiles: string[][];
  /** The text of every open Terminal (scrollback and screen), oldest Terminal first. */
  terminalText(): string[];
}

const terminals = new Set<Terminal>();

export const e2eHooks: E2eHooks | null =
  import.meta.env.VITE_E2E === "1"
    ? {
        pickedFiles: [],
        terminalText: () =>
          [...terminals].map((xterm) => {
            const buffer = xterm.buffer.active;
            const lines: string[] = [];
            for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
            return lines.join("\n");
          }),
      }
    : null;

if (e2eHooks) (window as unknown as { __sshastraE2E: E2eHooks }).__sshastraE2E = e2eHooks;

/** Lets the E2E test read `xterm` until the returned function is called. */
export function exposeTerminal(xterm: Terminal): () => void {
  if (!e2eHooks) return () => undefined;
  terminals.add(xterm);
  return () => terminals.delete(xterm);
}
