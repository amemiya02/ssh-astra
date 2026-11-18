import i18n from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { startI18n } from "@/i18n";
import type { ForwardEvent, PortForward } from "@/lib/ipc/forwards";
import type { Host } from "@/lib/ipc/hosts";
import { activeConnections, forwardStatusText, runningRules } from "./status";

const rule = (id: string, bindPort: number): PortForward => ({
  id,
  label: "",
  autoStart: false,
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

  it("lists Hosts held by Connect only after those with a Terminal, before those kept by forwards", () => {
    const [web, db, cache] = [host("web"), host("db", [rule("d1", 15432)]), host("cache")];

    const active = activeConnections([web], [running("db", "d1")], [web, db, cache], ["cache", "web", "gone"]);

    expect(active.map((h) => h.id)).toEqual(["web", "cache", "db"]);
  });
});

describe("forwardStatusText", () => {
  beforeAll(() => startI18n());
  const en = () => i18n.getFixedT("en");
  const zh = () => i18n.getFixedT("zh");

  it("shows a local forward as where it listens and where it goes", () => {
    expect(forwardStatusText(rule("l", 15432), en())).toBe("localhost:15432 → db:5432");
  });

  it("says a remote forward listens on the Host, in the UI language", () => {
    const remote: PortForward = {
      id: "r",
      label: "",
      autoStart: false,
      type: "remote",
      bindAddress: "localhost",
      bindPort: 9000,
      localHost: "127.0.0.1",
      localPort: 3000,
    };
    expect(forwardStatusText(remote, en())).toBe("on the Host localhost:9000 → 127.0.0.1:3000");
    expect(forwardStatusText(remote, zh())).toBe("Host 上 localhost:9000 → 127.0.0.1:3000");
  });

  it("shows a dynamic forward as a SOCKS proxy", () => {
    const socks: PortForward = { id: "s", label: "", autoStart: false, type: "dynamic", bindAddress: "127.0.0.1", bindPort: 1080 };
    expect(forwardStatusText(socks, en())).toBe("SOCKS localhost:1080");
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
