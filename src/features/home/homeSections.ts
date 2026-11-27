import type { Host, HostId, HostTree } from "@/lib/ipc/hosts";
import { searchTree, type HostMatches, type TreeNode } from "@/features/hosts/hostTree";

/** Hosts shown together on Home: one Group (its own Hosts, then each nested Group's), or the ungrouped ones. */
export interface HomeSection {
  /** The Group's id, or `"ungrouped"`. */
  id: string;
  /** `Production` or `Production / Web`; `null` for the Hosts in no Group. */
  title: string | null;
  hosts: { host: Host; matches?: HostMatches }[];
}

/**
 * Home's Hosts grouped by Group, narrowed by the search `query` (name, address, user; same
 * fuzzy match as the Host list). Groups come in tree order, the ungrouped Hosts last; a Group
 * with nothing to show is left out.
 */
export function homeSections(tree: HostTree, query: string): HomeSection[] {
  const sections: HomeSection[] = [];
  const ungrouped: HomeSection = { id: "ungrouped", title: null, hosts: [] };

  const walk = (nodes: TreeNode[], path: string[], section: HomeSection | null) => {
    for (const node of nodes) {
      if (node.kind === "host") {
        (section ?? ungrouped).hosts.push({ host: node.host, matches: node.matches });
        continue;
      }
      const inside = [...path, node.group.name];
      const here: HomeSection = { id: node.group.id, title: inside.join(" / "), hosts: [] };
      sections.push(here);
      // A Group's own Hosts come before its nested Groups' sections.
      walk(node.children.filter((child) => child.kind === "host"), inside, here);
      walk(node.children.filter((child) => child.kind === "group"), inside, here);
    }
  };
  walk(searchTree(tree, query), [], null);

  return [...sections, ungrouped].filter((section) => section.hosts.length > 0);
}

/** The first Host Home shows: the one Enter opens from the search field. */
export function firstHost(sections: HomeSection[]): Host | undefined {
  return sections[0]?.hosts[0]?.host;
}

/** The Hosts opened lately that still exist, most recent first, at most `limit`. */
export function recentHostsOf(hosts: Host[], recent: HostId[], limit: number): Host[] {
  const byId = new Map(hosts.map((host) => [host.id, host]));
  return recent.flatMap((id) => byId.get(id) ?? []).slice(0, limit);
}
