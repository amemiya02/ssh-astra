import { describe, expect, it } from "vitest";
import { parseQuickConnect } from "./quick-connect";

describe("parseQuickConnect", () => {
  it.each([
    ["host", { address: "host", port: 22 }],
    ["  user@host  ", { user: "user", address: "host", port: 22 }],
    ["user@host:2222", { user: "user", address: "host", port: 2222 }],
    ["127.0.0.1:2222", { address: "127.0.0.1", port: 2222 }],
    ["2001:db8::2222", { address: "2001:db8::2222", port: 22 }],
    ["user@[2001:db8::1]:2222", { user: "user", address: "2001:db8::1", port: 2222 }],
    ["[::1]", { address: "::1", port: 22 }],
  ])("parses %s", (input, target) => {
    expect(parseQuickConnect(input)).toEqual(target);
  });

  it.each([
    "", "ssh://host", "ssh host", "host/path", "-host", "host..com", "256.0.0.1",
    "@host", "user@@host", "user:password@host", "user@", "host:", "host:0", "host:65536", "host:+22",
    "2001:db8::oops", "[host]:22", "[::1", "[::1]:",
  ])("rejects %j", (input) => {
    expect(parseQuickConnect(input)).toBeUndefined();
  });
});
