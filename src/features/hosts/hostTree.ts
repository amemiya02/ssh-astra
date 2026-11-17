import type { Group, GroupId, Host, HostId, HostTree } from "@/lib/ipc/hosts";

/** Which characters of a Host's fields matched the search, by field. */
export type HostMatches = Partial<Record<"name" | "address" | "user", number[]>>;

export type TreeNode =
  | { kind: "group"; group: Group; children: TreeNode[] }
  | { kind: "host"; host: Host; matches?: HostMatches };

/**
 * Nests Groups and Hosts for display. Each level lists its Groups, then its
 * Hosts, in saved order. Anything whose parent is missing shows at the top
 * level rather than disappearing.
 */
export function buildTree({ groups, hosts }: HostTree, matches?: Map<HostId, HostMatches>): TreeNode[] {
  const groupIds = new Set(groups.map((g) => g.id));
  const parentOf = (id: GroupId | null) => (id !== null && groupIds.has(id) ? id : null);

  const level = (parent: GroupId | null, seen: Set<GroupId>): TreeNode[] => [
    ...groups
      .filter((g) => parentOf(g.parentId) === parent && !seen.has(g.id))
      .map((g): TreeNode => ({ kind: "group", group: g, children: level(g.id, new Set(seen).add(g.id)) })),
    ...hosts
      .filter((h) => parentOf(h.groupId) === parent)
      .map((h): TreeNode => ({ kind: "host", host: h, matches: matches?.get(h.id) })),
  ];
  return level(null, new Set());
}

/**
 * Case-insensitive fuzzy match: the indexes of `text` that match `query`.
 * A contiguous substring wins; otherwise the query's characters in order.
 */
export function fuzzyMatch(text: string, query: string): number[] | null {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return [];
  const at = haystack.indexOf(needle);
  if (at >= 0) return Array.from({ length: needle.length }, (_, i) => at + i);

  const indexes: number[] = [];
  let from = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, from);
    if (found < 0) return null;
    indexes.push(found);
    from = found + 1;
  }
  return indexes;
}

/**
 * The tree narrowed to Hosts whose name, address or user fuzzy-match `query`,
 * inside the Groups that hold them. A blank query returns the whole tree.
 */
export function searchTree(tree: HostTree, query: string): TreeNode[] {
  const q = query.trim();
  if (!q) return buildTree(tree);

  const matches = new Map<HostId, HostMatches>();
  for (const host of tree.hosts) {
    const found: HostMatches = {};
    for (const field of ["name", "address", "user"] as const) {
      const hit = fuzzyMatch(host[field], q);
      if (hit) found[field] = hit;
    }
    if (Object.keys(found).length > 0) matches.set(host.id, found);
  }

  const prune = (nodes: TreeNode[]): TreeNode[] =>
    nodes.flatMap((node): TreeNode[] => {
      if (node.kind === "host") return matches.has(node.host.id) ? [node] : [];
      const children = prune(node.children);
      return children.length > 0 ? [{ ...node, children }] : [];
    });
  return prune(buildTree(tree, matches));
}

export type DragItem = { kind: "host"; id: HostId } | { kind: "group"; id: GroupId };
/** What the item was dropped on; `root` is the empty space below the list. */
export type DropTarget = DragItem | { kind: "root" };
export type DropPosition = "before" | "after" | "inside";

/** A move for the HostStore: put `id` under `parentId` as its `index`-th sibling of its kind. */
export interface MoveOp {
  kind: "host" | "group";
  id: string;
  parentId: GroupId | null;
  index: number;
}

/**
 * Turns a drop into a HostStore move, or null when the drop is not allowed
 * (onto itself, or a Group into itself or a Group inside it).
 *
 * Hosts sit after a level's Groups, so a Host dropped on a Group goes into it
 * (last), and a Group dropped on a Host goes into that Host's Group (after
 * its other Groups). Indexes count siblings without the dragged item.
 */
export function dropMove(tree: HostTree, dragged: DragItem, target: DropTarget, position: DropPosition): MoveOp | null {
  if (target.kind !== "root" && target.kind === dragged.kind && target.id === dragged.id) return null;

  const groupById = new Map(tree.groups.map((g) => [g.id, g]));
  const hostById = new Map(tree.hosts.map((h) => [h.id, h]));
  const siblings = (parentId: GroupId | null): { id: string }[] =>
    dragged.kind === "host"
      ? tree.hosts.filter((h) => h.groupId === parentId && h.id !== dragged.id)
      : tree.groups.filter((g) => g.parentId === parentId && g.id !== dragged.id);

  let parentId: GroupId | null;
  let index: number;
  if (target.kind === "root") {
    parentId = null;
    index = siblings(null).length;
  } else if (target.kind === dragged.kind && !(target.kind === "group" && position === "inside")) {
    // Same kind, before or after the target: its sibling.
    const node = target.kind === "host" ? hostById.get(target.id) : groupById.get(target.id);
    if (!node) return null;
    parentId = "groupId" in node ? node.groupId : node.parentId;
    const at = siblings(parentId).findIndex((s) => s.id === target.id);
    index = at + (position === "after" ? 1 : 0);
  } else {
    // Into the target Group, or into the target Host's Group: last of its kind.
    if (target.kind === "group") {
      if (!groupById.has(target.id)) return null;
      parentId = target.id;
    } else {
      const node = hostById.get(target.id);
      if (!node) return null;
      parentId = node.groupId;
    }
    index = siblings(parentId).length;
  }

  if (dragged.kind === "group" && isWithin(groupById, parentId, dragged.id)) return null;
  return { kind: dragged.kind, id: dragged.id, parentId, index };
}

/** Whether `groupId` is `ancestor` or sits somewhere inside it. */
function isWithin(groups: Map<GroupId, Group>, groupId: GroupId | null, ancestor: GroupId): boolean {
  const seen = new Set<GroupId>();
  for (let id = groupId; id !== null && !seen.has(id); id = groups.get(id)?.parentId ?? null) {
    if (id === ancestor) return true;
    seen.add(id);
  }
  return false;
}
