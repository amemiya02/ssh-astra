import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { listCommandHistory, watchCommandHistory } from "@/lib/ipc/command-history";
import type { HostId } from "@/lib/ipc/hosts";
import { isPlainCommandText, selectHistorySuffix } from "./history-suggestion";
import type { ShellPromptInput, trackShellPromptInput } from "./shell-prompt-input";

interface HistoryTarget {
  host(): HostId | undefined;
  atPrompt(): boolean;
  insert(suffix: string): boolean;
}

type PendingEcho = { before: ShellPromptInput; expected?: string };

// Standard editing keys can redraw or reposition the current input. An unknown
// control sequence might launch a command or change the shell editor's mode.
const editorKeys = new Set(["\t", "\x01", "\x02", "\x05", "\x06", "\x08", "\x0b", "\x15", "\x17", "\x7f"]);
const editorEscape = /^(?:\[[A-DFH]|O[A-DFH]|\[[13478]~)$/;

function isEditorKey(data: string): boolean {
  return editorKeys.has(data) || (data.startsWith("\x1b") && editorEscape.test(data.slice(1)));
}

export function attachHistorySuggestions(xterm: Terminal, prompt: ReturnType<typeof trackShellPromptInput>, target: HistoryTarget) {
  const textarea = xterm.textarea;
  let history: readonly string[] = [];
  let host: HostId | undefined;
  let revision = 0;
  let stopWatching: (() => void) | undefined;
  let pending: PendingEcho | undefined;
  let editedMarker: IMarker | undefined;
  let composing = false;
  let shown: { input: ShellPromptInput; suffix: string; decoration: IDecoration; dispose(): void } | undefined;

  const hide = () => {
    shown?.dispose();
    shown = undefined;
  };
  const stop = () => {
    revision++;
    stopWatching?.();
    stopWatching = undefined;
    host = undefined;
    history = [];
    pending = undefined;
    editedMarker = undefined;
    hide();
  };

  const refresh = () => {
    const next = target.host();
    if (next !== host) {
      stop();
      if (next !== undefined) {
        host = next;
        stopWatching = watchCommandHistory(next, () => {
          const request = ++revision;
          history = [];
          hide();
          void listCommandHistory(next).then((commands) => {
            if (request !== revision || target.host() !== next) return;
            history = commands.filter(isPlainCommandText);
            refresh();
          }, () => undefined);
        });
      }
    }
    const input = host !== undefined && target.atPrompt() ? prompt.read() : undefined;
    if (pending && input) {
      const { before, expected } = pending;
      if (before.marker !== input.marker) {
        pending = undefined;
      } else if (expected !== undefined ? input.text === expected && input.atEnd
        : input.text !== before.text || input.cursorLine !== before.cursorLine || input.cursorColumn !== before.cursorColumn) {
        pending = undefined;
      }
    }
    if (!input?.atEnd || editedMarker !== input.marker || pending || composing || !textarea || textarea.ownerDocument.activeElement !== textarea) {
      hide();
      return;
    }
    const suffix = selectHistorySuffix(history, input.text);
    if (!suffix || conservativeColumns(suffix) > xterm.cols - input.cursorColumn) {
      hide();
      return;
    }
    if (shown?.suffix === suffix && samePosition(shown.input, input)) return;
    hide();
    const anchor = xterm.registerMarker();
    const decoration = xterm.registerDecoration({ marker: anchor, x: input.cursorColumn, width: xterm.cols - input.cursorColumn, layer: "top" });
    if (!decoration) {
      anchor.dispose();
      return;
    }
    const onPromptDisposed = input.marker.onDispose(() => anchor.dispose());
    decoration.onRender((element) => {
      if (element.textContent !== suffix) element.textContent = suffix;
      element.classList.add("terminal-history-suggestion");
      element.setAttribute("aria-hidden", "true");
      element.style.fontFamily = xterm.options.fontFamily ?? "monospace";
      element.style.fontSize = `${xterm.options.fontSize}px`;
      element.style.fontWeight = String(xterm.options.fontWeight);
      element.style.letterSpacing = `${xterm.options.letterSpacing}px`;
      element.style.color = xterm.options.theme?.foreground ?? "inherit";
    });
    shown = { input, suffix, decoration, dispose() {
      onPromptDisposed.dispose();
      anchor.dispose();
    } };
  };

  const observeInput = (data: string) => {
    hide();
    if (host === undefined || !target.atPrompt()) return;
    const before = pending?.before ?? prompt.read();
    const text = data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~") ? data.slice(6, -6) : data;
    // Wait for the complete echo of consecutive input, even across output chunks.
    const previous = pending?.expected ?? (before?.atEnd ? before.text : undefined);
    if (before && previous !== undefined && (pending === undefined || pending.expected !== undefined) && text &&
      isPlainCommandText(previous + text)) {
      pending = { before, expected: previous + text };
      editedMarker = before.marker;
    } else if (before && !pending && (isEditorKey(data) || isPlainCommandText(text))) {
      pending = { before };
      editedMarker = before.marker;
    } else {
      pending = undefined;
      editedMarker = undefined;
      prompt.reset();
    }
  };
  const onCompositionStart = () => { composing = true; hide(); };
  const onCompositionEnd = () => { composing = false; };
  textarea?.addEventListener("compositionstart", onCompositionStart);
  textarea?.addEventListener("compositionend", onCompositionEnd);
  textarea?.addEventListener("focus", refresh);
  textarea?.addEventListener("blur", hide);
  const scroll = xterm.onScroll(refresh);

  return {
    refresh,
    hide,
    observeInput,
    accept(event: KeyboardEvent): boolean {
      if (!shown?.decoration.element?.isConnected || host !== target.host() || !target.atPrompt() || composing ||
        event.repeat || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey ||
        (event.key !== "ArrowRight" && event.key !== "End")) return false;
      const current = prompt.read();
      const { input, suffix } = shown;
      if (!current?.atEnd || !samePosition(current, input) || textarea?.ownerDocument.activeElement !== textarea) return false;
      hide();
      return target.insert(suffix);
    },
    reset: stop,
    dispose() {
      stop();
      scroll.dispose();
      textarea?.removeEventListener("compositionstart", onCompositionStart);
      textarea?.removeEventListener("compositionend", onCompositionEnd);
      textarea?.removeEventListener("focus", refresh);
      textarea?.removeEventListener("blur", hide);
    },
  };
}

function samePosition(a: ShellPromptInput, b: ShellPromptInput): boolean {
  return a.marker === b.marker && a.cursorLine === b.cursorLine && a.cursorColumn === b.cursorColumn && a.text === b.text;
}

/** Allow room for wide glyphs and keep the complete suffix on screen. */
function conservativeColumns(text: string): number {
  let columns = 0;
  for (const character of text) columns += character.codePointAt(0)! < 0x7f ? 1 : 2;
  return columns;
}
