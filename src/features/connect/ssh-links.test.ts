import { expect, it } from "vitest";
import type { Host, TemporaryHost } from "@/lib/ipc/hosts";
import { matchSshLink } from "./ssh-links";

const target = { address: "example.test", port: 22, user: "deploy" };
const saved: Host = {
  ...target, id: "saved", name: "Production", auth: { type: "auto" },
  jumpHost: null, groupId: null, forwards: [],
};

it("matches the full destination and ignores Host names and Temporary Hosts", () => {
  const temporary: TemporaryHost = { ...saved, id: "temporary", temporary: true };
  const hosts = [
    temporary,
    { ...saved, id: "different-address", name: target.address, address: "other.test" },
    { ...saved, id: "different-port", port: 2222 },
    { ...saved, id: "different-user", user: "Deploy" },
    saved,
  ];

  expect(matchSshLink(hosts, target)).toBe(saved);
  expect(matchSshLink(hosts.slice(0, -1), target)).toBeUndefined();
});

it("does not pick an arbitrary saved route when two Hosts share the same destination", () => {
  const viaJump = { ...saved, id: "via-jump", jumpHost: "gateway" };
  expect(matchSshLink([saved, viaJump], target)).toBeUndefined();
});
