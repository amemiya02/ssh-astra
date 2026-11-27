import { describe, expect, it } from "vitest";
import type { Group, Host, HostTree } from "@/lib/ipc/hosts";
import { firstHost, homeSections, recentHostsOf } from "./homeSections";

const host = (id: string, groupId: string | null = null, extra: Partial<Host> = {}): Host => ({
  id,
  name: id,
  address: `${id}.example.com`,
  port: 22,
  user: "deploy",
  auth: { type: "password" },
  jumpHost: null,
  groupId,
  forwards: [],
  ...extra,
});
const group = (id: string, parentId: string | null = null): Group => ({ id, name: id, parentId });

const tree: HostTree = {
  groups: [group("Production"), group("Web", "Production"), group("Empty")],
  hosts: [host("bastion", "Production"), host("web-01", "Web"), host("nas")],
};

describe("homeSections", () => {
  it("groups Hosts by Group, a Group's own Hosts first, ungrouped Hosts last, empty Groups left out", () => {
    expect(homeSections(tree, "").map((s) => [s.title, s.hosts.map((h) => h.host.id)])).toEqual([
      ["Production", ["bastion"]],
      ["Production / Web", ["web-01"]],
      [null, ["nas"]],
    ]);
  });

  it("narrows to the Hosts matching the search, in their Groups", () => {
    const sections = homeSections(tree, "web");
    expect(sections.map((s) => s.title)).toEqual(["Production / Web"]);
    expect(sections[0]!.hosts[0]!.matches?.name).toEqual([0, 1, 2]);
  });

  it("finds Hosts by address and user too", () => {
    expect(homeSections(tree, "nas.example")[0]!.hosts[0]!.host.id).toBe("nas");
    expect(homeSections({ groups: [], hosts: [host("a", null, { user: "root" })] }, "root")).toHaveLength(1);
  });

  it("is empty when nothing matches", () => {
    expect(homeSections(tree, "zzz")).toEqual([]);
  });
});

describe("firstHost", () => {
  it("is the first Host shown, which Enter opens", () => {
    expect(firstHost(homeSections(tree, ""))?.id).toBe("bastion");
    expect(firstHost(homeSections(tree, "nas"))?.id).toBe("nas");
    expect(firstHost([])).toBeUndefined();
  });
});

describe("recentHostsOf", () => {
  it("lists the recent Hosts that still exist, newest first, up to the limit", () => {
    expect(recentHostsOf(tree.hosts, ["nas", "gone", "web-01", "bastion"], 2).map((h) => h.id)).toEqual(["nas", "web-01"]);
  });
});
