import type { HighlightReply, HighlightRequest } from "./terminal-highlight-worker";

type Result = Extract<HighlightReply, { matches: unknown }> | { timedOut: number } | { unavailable: true };
type Job = HighlightRequest & { done: (result: Result) => void };

const startupTimeout = 2_000;
const ruleTimeout = 200;
const idleTimeout = 5_000;

const queue: Job[] = [];
let worker: Worker | undefined;
let current: Job | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastRule: number | undefined;

function stopWorker() {
  if (!worker) return;
  worker.onmessage = null;
  worker.onerror = null;
  worker.terminate();
  worker = undefined;
}

function finish(result?: Result) {
  clearTimeout(timer);
  const finished = current;
  current = undefined;
  if (finished && result) finished.done(result);

  if (queue.length) startNext();
  else timer = setTimeout(stopWorker, idleTimeout);
}

function fail() {
  stopWorker();
  finish({ unavailable: true });
}

function armTimeout(delay: number) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    stopWorker();
    finish(lastRule === undefined ? { unavailable: true } : { timedOut: lastRule });
  }, delay);
}

function startNext() {
  if (current || !queue.length) return;
  current = queue.shift()!;
  lastRule = undefined;
  const { lines, rules } = current;
  try {
    if (!worker) {
      worker = new Worker(new URL("./terminal-highlight-worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }: MessageEvent<HighlightReply>) => {
        if ("ruleStarted" in data) {
          lastRule = data.ruleStarted;
          armTimeout(ruleTimeout);
        } else {
          finish(data);
        }
      };
      worker.onerror = fail;
      armTimeout(startupTimeout);
    } else {
      armTimeout(ruleTimeout);
    }
    worker.postMessage({ lines, rules } satisfies HighlightRequest);
  } catch {
    fail();
  }
}

/** At most one Worker per window. Each pane can cancel its own queued or running batch. */
export function requestHighlightMatches(request: HighlightRequest, done: Job["done"]): () => void {
  const job = { ...request, done };
  queue.push(job);
  queueMicrotask(startNext);
  return () => {
    if (current === job) {
      stopWorker();
      finish();
    } else {
      const index = queue.indexOf(job);
      if (index !== -1) queue.splice(index, 1);
    }
  };
}
