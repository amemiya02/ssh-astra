import { expect, it, vi } from "vitest";
import { requestHighlightMatches } from "./terminal-highlight-jobs";
import type { HighlightReply, HighlightRequest } from "./terminal-highlight-worker";

it("recovers from a slow rule and runs the next pane's match with a fresh Worker", async () => {
  const workers: TestWorker[] = [];
  class TestWorker {
    onmessage: ((event: { data: HighlightReply }) => void) | null = null;
    readonly postMessage = vi.fn();
    readonly terminate = vi.fn();

    constructor() {
      workers.push(this);
    }

    reply(data: HighlightReply) {
      this.onmessage?.({ data });
    }
  }

  const first = vi.fn();
  const second = vi.fn();
  const rules: HighlightRequest["rules"] = [{ pattern: "error", kind: "regex", hue: "red", enabled: true }];
  vi.stubGlobal("Worker", TestWorker);
  vi.useFakeTimers();
  const cancelFirst = requestHighlightMatches({ lines: ["error"], rules }, first);
  const cancelSecond = requestHighlightMatches({ lines: ["another error"], rules }, second);
  try {
    await Promise.resolve();
    expect(workers).toHaveLength(1);
    expect(workers[0]!.postMessage).toHaveBeenCalledOnce();
    workers[0]!.reply({ ruleStarted: 0 });

    await vi.advanceTimersByTimeAsync(500);
    expect(first).toHaveBeenCalledWith({ timedOut: 0 });
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(workers).toHaveLength(2);
    expect(workers[1]!.postMessage).toHaveBeenCalledWith({ lines: ["another error"], rules });

    const reply = { matches: [[{ start: 8, end: 13, hue: "red" as const }]] };
    workers[1]!.reply(reply);
    expect(second).toHaveBeenCalledWith(reply);
  } finally {
    cancelFirst();
    cancelSecond();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
