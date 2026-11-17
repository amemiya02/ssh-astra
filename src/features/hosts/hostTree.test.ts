import { describe, expect, it } from "vitest";
import type { Group, Host, HostTree } from "@/lib/ipc/hosts";
import { buildTree, dropMove, fuzzyMatch, searchTree, type TreeNode } from "./hostTree";

const host = (id: string, groupId: string | null = null, extra: Partial<Host> = {}): Host => ({
  id,
  name: id,
  address: `${id}.example.com`,
  port: 22,
  user: "deploy",
  auth: { type: "password" },
  jumpHost: null,
  groupId,
  ...extra,
});
const group = (id: string, parentId: string | null = null): Group => ({ id, name: id, parentId });

/** A compact picture of the tree: groups as `name/[...]`, hosts as their id. */
const shape = (nodes: TreeNode[]): unknown[] =>
  nodes.map((n) => (n.kind === "group" ? { [n.group.name]: shape(n.children) } : n.host.id));

const sample: HostTree = {
  groups: [group("prod"), group("web", "prod"), group("dev")],
  hosts: [host("a"), host("p1", "prod"), host("w1", "web"), host("b"), host("p2", "prod")],
};

describe("buildTree", () => {
  it("nests Groups and lists each level's Groups before its Hosts, in saved order", () => {
    expect(shape(buildTree(sample))).toEqual([{ prod: [{ web: ["w1"] }, "p1", "p2"] }, { dev: [] }, "a", "b"]);
  });

  it("shows Hosts and Groups whose parent is missing at the top level rather than losing them", () => {
    const tree = { groups: [group("orphan", "gone")], hosts: [host("h", "gone")] };
    expect(shape(buildTree(tree))).toEqual([{ orphan: [] }, "h"]);
  });
});

describe("fuzzyMatch", () => {
  it("prefers a contiguous, case-insensitive substring", () => {
    expect(fuzzyMatch("Web-Server", "serv")).toEqual([4, 5, 6, 7]);
  });

  it("falls back to the letters in order", () => {
    expect(fuzzyMatch("production-db", "pdb")).toEqual([0, 3, 12]);
  });

  it("returns null when the letters are not all there in order", () => {
    expect(fuzzyMatch("web", "bew")).toBeNull();
  });
});

describe("searchTree", () => {
  it("keeps Hosts whose name, address or user match, inside their Groups, with the matched characters", () => {
    const tree: HostTree = {
      groups: [group("prod"), group("dev")],
      hosts: [
        host("api", "prod", { address: "10.0.0.1" }),
        host("db", "dev", { user: "postgres", address: "10.0.0.2" }),
        host("cache", null, { address: "10.0.0.3" }),
      ],
    };

    const byName = searchTree(tree, "API");
    expect(shape(byName)).toEqual([{ prod: ["api"] }]);
    const api = (byName[0] as Extract<TreeNode, { kind: "group" }>).children[0];
    expect(api).toMatchObject({ kind: "host", matches: { name: [0, 1, 2] } });

    expect(shape(searchTree(tree, "postg"))).toEqual([{ dev: ["db"] }]);
    expect(shape(searchTree(tree, "0.0.3"))).toEqual(["cache"]);
    expect(searchTree(tree, "zzz")).toEqual([]);
  });

  it("returns the whole tree for a blank query", () => {
    expect(shape(searchTree(sample, "  "))).toEqual(shape(buildTree(sample)));
  });
});

describe("dropMove", () => {
  const tree = sample;

  it("drops a Host before or after another Host in that Host's Group", () => {
    expect(dropMove(tree, { kind: "host", id: "p2" }, { kind: "host", id: "p1" }, "before")).toEqual({
      kind: "host",
      id: "p2",
      parentId: "prod",
      index: 0,
    });
    expect(dropMove(tree, { kind: "host", id: "a" }, { kind: "host", id: "p1" }, "after")).toEqual({
      kind: "host",
      id: "a",
      parentId: "prod",
      index: 1,
    });
  });

  it("counts positions without the dragged item when reordering in the same Group", () => {
    // Top level Hosts are a, b. Dragging a after b puts it at index 1 of [b].
    expect(dropMove(tree, { kind: "host", id: "a" }, { kind: "host", id: "b" }, "after")).toMatchObject({
      parentId: null,
      index: 1,
    });
  });

  it("drops a Host onto a Group into that Group, last", () => {
    expect(dropMove(tree, { kind: "host", id: "a" }, { kind: "group", id: "prod" }, "inside")).toEqual({
      kind: "host",
      id: "a",
      parentId: "prod",
      index: 2,
    });
  });

  it("drops a Group before, after or into another Group", () => {
    expect(dropMove(tree, { kind: "group", id: "dev" }, { kind: "group", id: "prod" }, "before")).toEqual({
      kind: "group",
      id: "dev",
      parentId: null,
      index: 0,
    });
    expect(dropMove(tree, { kind: "group", id: "dev" }, { kind: "group", id: "web" }, "inside")).toEqual({
      kind: "group",
      id: "dev",
      parentId: "web",
      index: 0,
    });
  });

  it("drops a Group onto a Host into that Host's Group, after its other Groups", () => {
    expect(dropMove(tree, { kind: "group", id: "dev" }, { kind: "host", id: "p1" }, "before")).toEqual({
      kind: "group",
      id: "dev",
      parentId: "prod",
      index: 1,
    });
  });

  it("refuses to drop a Group into itself or a Group inside it, or anything onto itself", () => {
    expect(dropMove(tree, { kind: "group", id: "prod" }, { kind: "group", id: "web" }, "inside")).toBeNull();
    expect(dropMove(tree, { kind: "group", id: "prod" }, { kind: "host", id: "w1" }, "after")).toBeNull();
    expect(dropMove(tree, { kind: "group", id: "prod" }, { kind: "group", id: "prod" }, "inside")).toBeNull();
    expect(dropMove(tree, { kind: "host", id: "a" }, { kind: "host", id: "a" }, "after")).toBeNull();
  });

  it("drops onto the empty space below the list at the end of the top level", () => {
    expect(dropMove(tree, { kind: "host", id: "p1" }, { kind: "root" }, "inside")).toEqual({
      kind: "host",
      id: "p1",
      parentId: null,
      index: 2,
    });
  });
});
