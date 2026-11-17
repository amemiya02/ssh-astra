import { describe, expect, it } from "vitest";
import type { ForwardEvent, PortForward } from "@/lib/ipc/forwards";
import type { Host } from "@/lib/ipc/hosts";
import { activeConnections, runningRules } from "./status";

const rule = (id: string, bindPort: number): PortForward => ({
  id,
  label: "",
  type: "local",
  bindAddress: "127.0.0.1",
  bindPort,
  remoteHost: "db",
  remotePort: 5432,
});
const host = (id: string, forwards: PortForward[] = []): Host => ({
  id,
  name: `${id}-name`,
  address: "10.0.0.5",
  port: 22,
  user: "deploy",
  auth: { type: "password" },
  jumpHost: null,
  groupId: null,
  forwards,
});
const running = (hostId: string, forwardId: string): ForwardEvent => ({
  hostId,
  forwardId,
  status: { state: "running" },
});

describe("activeConnections", () => {
  it("lists Hosts with a connected Terminal, then Hosts kept connected only by Port forwards, each once", () => {
    const [web, db, cache] = [host("web", [rule("w1", 8080)]), host("db", [rule("d1", 15432), rule("d2", 15433)]), host("cache")];
    const hosts = [web, db, cache];

    const active = activeConnections([web], [running("db", "d1"), running("web", "w1"), running("db", "d2")], hosts);

    expect(active.map((h) => h.id)).toEqual(["web", "db"]);
  });

  it("skips forwards of Hosts no longer in the list", () => {
    expect(activeConnections([], [running("gone", "x")], [host("web")])).toEqual([]);
  });
});

describe("runningRules", () => {
  it("pairs each running forward with its Host and saved rule", () => {
    const db = host("db", [rule("d1", 15432), rule("d2", 15433)]);
    expect(runningRules([running("db", "d2"), running("db", "missing")], [db])).toEqual([
      { host: db, rule: db.forwards[1] },
    ]);
  });
});
