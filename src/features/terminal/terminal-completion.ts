import type { Terminal } from "@xterm/xterm";
import { listTerminalPaths, type TerminalId } from "@/lib/ipc/terminal";
import { completePaths, completionLimit, planCompletion, type CompletionCandidate } from "./command-completion";
import { sameShellPromptInput, type ShellPromptInput } from "./shell-prompt-input";

type CompletionStatus = "loading" | "integrationOff" | "integrationUnavailable" | "promptUnavailable" | "pathUnavailable" | "empty";
export type CompletionView =
  | { status: CompletionStatus }
  | { candidates: CompletionCandidate[]; selected: number };

interface Source {
  id: TerminalId;
  generation: number;
  cwd?: string;
  input: ShellPromptInput;
}

interface Target {
  enabled(): boolean;
  source(): Source | "integrationOff" | "integrationUnavailable" | "promptUnavailable";
  show(view: CompletionView | undefined): void;
  insert(source: Source, text: string): void;
}

export function trackTerminalCompletion(xterm: Terminal, target: Target) {
  const textarea = xterm.textarea;
  let request: AbortController | undefined;
  let snapshot: Source | undefined;
  let view: CompletionView | undefined;
  let completedWithEnter = false;

  const show = (next: CompletionView | undefined) => {
    view = next;
    target.show(next);
  };
  const close = () => {
    request?.abort();
    request = undefined;
    snapshot = undefined;
    if (view) show(undefined);
  };
  function current(source: Source) {
    const latest = target.source();
    return target.enabled() && textarea?.ownerDocument.activeElement === textarea &&
      typeof latest !== "string" && latest.id === source.id && latest.generation === source.generation &&
      latest.cwd === source.cwd && latest.input.atEnd && sameShellPromptInput(latest.input, source.input);
  }

  const refresh = () => {
    if ((!target.enabled() && view) || (snapshot && !current(snapshot))) close();
  };
  const scroll = xterm.onScroll(refresh);
  const resized = xterm.onResize(close);
  const alternate = xterm.buffer.onBufferChange(close);
  textarea?.addEventListener("blur", close);
  textarea?.addEventListener("compositionstart", close);

  async function open() {
    close();
    const source = target.source();
    if (typeof source === "string") {
      show({ status: source });
      return;
    }
    const pending = new AbortController();
    request = pending;
    snapshot = source;
    show({ status: "loading" });
    try {
      const { default: catalog } = await import("./completion-catalog.json");
      if (pending.signal.aborted || !current(source)) return;
      const plan = planCompletion(catalog, source.input.text, source.cwd);
      let candidates = plan.candidates;
      let pathUnavailable = plan.missingDirectory ?? false;
      if (plan.paths) {
        const path = plan.paths;
        try {
          const entries = await listTerminalPaths(source.id, source.generation, {
            directory: path.directory, prefix: path.prefix, directoriesOnly: path.directoriesOnly,
          }, pending.signal);
          if (entries) {
            const staticLabels = new Set(candidates.map(({ label }) => label));
            const paths = completePaths(path, entries).filter(({ label }) => !staticLabels.has(label));
            candidates = [...candidates, ...paths].slice(0, completionLimit);
          }
        } catch {
          pathUnavailable = true;
        }
      }
      if (pending.signal.aborted || !current(source)) return;
      show(candidates.length
        ? { candidates, selected: 0 }
        : { status: pathUnavailable ? "pathUnavailable" : "empty" });
    } catch {
      if (!pending.signal.aborted && current(source)) show({ status: "empty" });
    } finally {
      if (request === pending) {
        request = undefined;
        if (!current(source)) close();
      }
    }
  }

  function accept(candidate: CompletionCandidate): boolean {
    const source = snapshot;
    if (!source || !view || !("candidates" in view) || !view.candidates.includes(candidate) || !current(source)) {
      close();
      return false;
    }
    close();
    target.insert(source, candidate.insert);
    return true;
  }

  return {
    open(repeat: boolean) {
      if (!target.enabled()) return false;
      if (!repeat) void open();
      return true;
    },
    refresh,
    close,
    accept,
    key(event: KeyboardEvent): boolean {
      if (event.key === "Enter") {
        if (event.repeat && completedWithEnter) return true;
        completedWithEnter = false;
      }
      if (!view) return false;
      if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (event.key === "Escape") {
          close();
          return true;
        }
        if (event.key === "Enter") {
          if ("candidates" in view && !event.repeat) accept(view.candidates[view.selected]!);
          else close();
          completedWithEnter = true;
          return true;
        }
        if ("candidates" in view) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const { selected, candidates } = view;
            const next = selected + (event.key === "ArrowDown" ? 1 : -1);
            show({ candidates, selected: (next + candidates.length) % candidates.length });
            return true;
          }
        }
      }
      // Tab and every ordinary edit continue to xterm with the list closed.
      close();
      return false;
    },
    dispose() {
      close();
      scroll.dispose();
      resized.dispose();
      alternate.dispose();
      textarea?.removeEventListener("blur", close);
      textarea?.removeEventListener("compositionstart", close);
    },
  };
}
