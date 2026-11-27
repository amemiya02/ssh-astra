import { expect, it } from "vitest";
import type { ResourceSnapshot } from "@/lib/ipc/resources";
import { recordResourceSample, resizeResourceHistory, type ResourceTrendSample } from "./resource-history";

const snapshot: ResourceSnapshot = {
  cpuPercent: 12, cores: 4, load: [0.3, 0.4, 0.5],
  memory: { used: 3, total: 4 }, swap: { used: 0, total: 0 },
  disks: [], network: [], uptimeSeconds: 150,
};

it.each([[1, 300], [2, 150], [5, 60]] as const)(
  "keeps no more than %i-second sampling needs across five minutes",
  (seconds, capacity) => {
    let history: readonly ResourceTrendSample[] = [];
    for (let index = 0; index < 400; index++) {
      history = recordResourceSample(history, snapshot, index * 100, seconds);
    }
    expect(history).toHaveLength(capacity);
    expect(history.at(-1)?.sampledAt).toBe(39900);
  },
);

it("expires readings outside five minutes after a gap without changing the input", () => {
  const oldest = recordResourceSample([], snapshot, 500, 2);
  const recent = recordResourceSample(oldest, snapshot, 900, 2);
  const afterGap = recordResourceSample(recent, snapshot, 300500, 2);

  expect(afterGap.map(({ sampledAt }) => sampledAt)).toEqual([900, 300500]);
  expect(recent.map(({ sampledAt }) => sampledAt)).toEqual([500, 900]);
});

it("keeps the full time range when switching to a slower interval", () => {
  let history: readonly ResourceTrendSample[] = [];
  for (let seconds = 1; seconds <= 300; seconds++) {
    history = recordResourceSample(history, snapshot, seconds * 1000, 1);
  }

  const resized = resizeResourceHistory(history, 300000, 5);

  expect(resized).toHaveLength(60);
  expect(resized[0]?.sampledAt).toBe(5000);
  expect(resized.at(-1)?.sampledAt).toBe(300000);
});
