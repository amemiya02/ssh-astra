import { describe, expect, it } from "vitest";
import { connectionSetting, defaultConnectionSettings } from "./connection-settings";

describe("the connection settings section", () => {
  it("defaults to the system agent with a 30-second keepalive interval", () => {
    expect(connectionSetting.key).toBe("connection");
    expect(defaultConnectionSettings).toEqual({ keepaliveSeconds: 30, agentPath: "", detectOs: true });
  });

  it("keeps a valid keepalive interval, including off", () => {
    expect(connectionSetting.parse({ keepaliveSeconds: 60, detectOs: false })).toEqual({ keepaliveSeconds: 60, agentPath: "", detectOs: false });
    expect(connectionSetting.parse({ keepaliveSeconds: 0 }).keepaliveSeconds).toBe(0);
  });

  it("repairs a missing, damaged or out-of-range value", () => {
    expect(connectionSetting.parse(undefined)).toEqual(defaultConnectionSettings);
    expect(connectionSetting.parse({ keepaliveSeconds: "soon" }).keepaliveSeconds).toBe(30);
    expect(connectionSetting.parse({ keepaliveSeconds: -5 }).keepaliveSeconds).toBe(30);
    expect(connectionSetting.parse({ keepaliveSeconds: 12.6 }).keepaliveSeconds).toBe(13);
    expect(connectionSetting.parse({ keepaliveSeconds: 100000 }).keepaliveSeconds).toBe(3600);
  });

  it("reads Unix socket and Windows pipe paths, with a blank path for the system agent", () => {
    const socket = "~/Library/Group Containers/agent.sock";
    const pipe = String.raw`\\.\pipe\custom-ssh-agent`;
    expect(connectionSetting.parse({ keepaliveSeconds: 60, agentPath: socket })).toEqual({
      keepaliveSeconds: 60,
      agentPath: socket,
      detectOs: true,
    });
    expect(connectionSetting.parse({ agentPath: pipe }).agentPath).toBe(pipe);
    expect(connectionSetting.parse({ agentPath: "  " }).agentPath).toBe("");
    expect(connectionSetting.parse({ agentPath: 42 }).agentPath).toBe("");
  });
});

it("keeps only the proxy endpoint and account in connection settings", () => {
  const proxy = { kind: "httpConnect", address: "proxy.example", port: 3128, username: "dev" };
  expect(connectionSetting.parse({ proxy: { ...proxy, password: "secret-marker" } }).proxy).toEqual(proxy);
  expect(connectionSetting.parse({ proxy: { ...proxy, address: "user@proxy.example" } }).proxy).toBeUndefined();
});
