import { describe, expect, it } from "vitest";
import type { ForwardEvent } from "@/lib/ipc/forwards";
import type { Host } from "@/lib/ipc/hosts";
import { hostsWithForwards } from "./forwardsSummary";

const rule = (id: string) => ({ id, label: id, autoStart: false, type: "dynamic", bindAddress: "localhost", bindPort: 1080 }) as Host["forwards"][number];
const host = (id: string, forwards: string[]): Host => ({
  id,
  name: id,
  address: "10.0.0.5",
  port: 22,
  user: "deploy",
  auth: { type: "password" },
  jumpHost: null,
  groupId: null,
  forwards: forwards.map(rule),
});
const running = (hostId: string, forwardId: string): ForwardEvent => ({ hostId, forwardId, status: { state: "running" } });

describe("hostsWithForwards", () => {
  it("lists only Hosts with rules, counting the running ones", () => {
    const hosts = [host("web", ["a", "b"]), host("db", []), host("api", ["c"])];
    expect(hostsWithForwards(hosts, [running("web", "a"), running("api", "c")])).toEqual([
      { host: hosts[0], running: 1, total: 2 },
      { host: hosts[2], running: 1, total: 1 },
    ]);
  });

  it("ignores running rules the Host no longer has", () => {
    const hosts = [host("web", ["a"])];
    expect(hostsWithForwards(hosts, [running("web", "gone")])[0]).toMatchObject({ running: 0, total: 1 });
  });

  it("is empty when no Host has rules", () => {
    expect(hostsWithForwards([host("web", [])], [])).toEqual([]);
  });
});
