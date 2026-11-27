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
  /** Minimal buffer and renderer observations for the manual benchmark. */
  terminalMetrics(tailLines?: number): TerminalMetrics[];
  setFocusedCursorBlink(enabled: boolean): void;
  trackOutput(terminal: Terminal, data: Uint8Array): void;
  trackInput(terminal: Terminal, characters: number): void;
}

interface TerminalCounters {
  renders: number;
  outputMessages: number;
  outputBytes: number;
  pendingOutputBytes: number;
  peakPendingOutputBytes: number;
  inputCharacters: number;
}

interface TerminalMetrics extends TerminalCounters {
  bufferLines: number;
  scrollbackLines: number;
  focused: boolean;
  visible: boolean;
  webgl: boolean;
  tail: string;
}

const terminals = new Map<Terminal, TerminalCounters>();

export const e2eHooks: E2eHooks | null =
  import.meta.env.VITE_E2E === "1"
    ? {
        pickedFiles: [],
        terminalText: () =>
          [...terminals.keys()].map((xterm) => {
            const buffer = xterm.buffer.active;
            const lines: string[] = [];
            for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
            return lines.join("\n");
          }),
        terminalMetrics: (tailLines = 0) =>
          [...terminals].map(([xterm, counters]) => {
            const buffer = xterm.buffer.active;
            const end = buffer.baseY + buffer.cursorY + 1;
            const lines: string[] = [];
            for (let y = Math.max(0, end - tailLines); y < end; y++) {
              const line = buffer.getLine(y);
              if (!line) continue;
              const text = line.translateToString(!buffer.getLine(y + 1)?.isWrapped);
              if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
              else lines.push(text);
            }
            const canvases = xterm.element?.querySelectorAll<HTMLCanvasElement>(".xterm-screen canvas") ?? [];
            return {
              ...counters,
              bufferLines: buffer.length,
              scrollbackLines: buffer.baseY,
              focused: xterm.textarea === document.activeElement,
              visible: Boolean(xterm.element?.getClientRects().length),
              webgl: Array.from(canvases).some((canvas) => canvas.getContext("webgl2")?.isContextLost() === false),
              tail: lines.join("\n"),
            };
          }),
        setFocusedCursorBlink: (enabled) => {
          const terminal = [...terminals.keys()].find((xterm) => xterm.textarea === document.activeElement);
          if (!terminal) throw new Error("No Terminal has focus");
          terminal.options.cursorBlink = enabled;
        },
        trackOutput: (terminal, data) => {
          const counters = terminals.get(terminal);
          if (!counters) {
            terminal.write(data);
            return;
          }
          counters.outputMessages++;
          counters.outputBytes += data.byteLength;
          counters.pendingOutputBytes += data.byteLength;
          counters.peakPendingOutputBytes = Math.max(counters.peakPendingOutputBytes, counters.pendingOutputBytes);
          terminal.write(data, () => { counters.pendingOutputBytes -= data.byteLength; });
        },
        trackInput: (terminal, characters) => {
          const counters = terminals.get(terminal);
          if (counters) counters.inputCharacters += characters;
        },
      }
    : null;

if (e2eHooks) (window as unknown as { __sshastraE2E: E2eHooks }).__sshastraE2E = e2eHooks;

/** Lets the E2E test read `xterm` until the returned function is called. */
export function exposeTerminal(xterm: Terminal): () => void {
  if (!e2eHooks) return () => undefined;
  const counters: TerminalCounters = {
    renders: 0,
    outputMessages: 0,
    outputBytes: 0,
    pendingOutputBytes: 0,
    peakPendingOutputBytes: 0,
    inputCharacters: 0,
  };
  // xterm's public onRender excludes cursor-only redraws. This E2E probe
  // reads the renderer event in the version pinned by pnpm-lock.yaml.
  const { _renderService } = (xterm as unknown as {
    _core: { _renderService: { onRender(callback: () => void): { dispose(): void } } };
  })._core;
  const render = _renderService.onRender(() => { counters.renders++; });
  terminals.set(xterm, counters);
  return () => {
    render.dispose();
    terminals.delete(xterm);
  };
}
