import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { readCommandError } from "@/lib/ipc/connect";
import * as forwardsIpc from "@/lib/ipc/forwards";
import type { ForwardDraft, ForwardId, PortForward } from "@/lib/ipc/forwards";
import * as hostsIpc from "@/lib/ipc/hosts";
import type { Group, GroupId, Host, HostDraft, HostId, HostTree } from "@/lib/ipc/hosts";
import type { MoveOp } from "./hostTree";

const ipc = { ...hostsIpc, ...forwardsIpc };

/** The HostStore commands the hosts store uses (`@/lib/ipc/hosts`, `@/lib/ipc/forwards`); a fake in tests. */
export type HostsApi = Pick<
  typeof ipc,
  | "loadHostTree"
  | "saveHost"
  | "deleteHost"
  | "duplicateHost"
  | "moveHost"
  | "moveGroup"
  | "createGroup"
  | "renameGroup"
  | "deleteGroup"
  | "saveForward"
  | "deleteForward"
>;

export interface HostsState {
  tree: HostTree;
  status: "loading" | "ready" | "error";
  /** Why the Host list could not be loaded (e.g. a damaged file). */
  error: string | null;
  load(): Promise<void>;
  /** Adds a Host (no `id`) at the top level, or saves edits to the Host with `id`. */
  saveHost(draft: HostDraft, id?: HostId): Promise<Host>;
  deleteHost(id: HostId): Promise<void>;
  /** Saves a copy as `name` right after the original. */
  duplicateHost(id: HostId, name: string): Promise<Host>;
  /** Moves a Host or Group (drag and drop, "Move to"). */
  move(op: MoveOp): Promise<void>;
  createGroup(name: string, parentId: GroupId | null): Promise<Group>;
  renameGroup(id: GroupId, name: string): Promise<Group>;
  /** Deletes a Group; its contents move up into its parent. */
  deleteGroup(id: GroupId): Promise<void>;
  /** Adds a Port forward rule to a Host (no `id`), or saves edits to its rule `id`. */
  saveForward(hostId: HostId, draft: ForwardDraft, id?: ForwardId): Promise<PortForward>;
  /** Stops and deletes a Host's Port forward rule. */
  deleteForward(hostId: HostId, id: ForwardId): Promise<void>;
}

/**
 * The Host list as the UI sees it. Every change goes through the HostStore
 * first and is shown only once it is saved, so a refused change leaves the
 * list as it was; actions reject with the backend's `CommandError`.
 */
export function createHostsStore(api: HostsApi): StoreApi<HostsState> {
  return createStore<HostsState>()((set, get) => {
    const update = (change: (tree: HostTree) => HostTree) => set({ tree: change(get().tree) });
    const updateForwards = (hostId: HostId, change: (forwards: PortForward[]) => PortForward[]) =>
      update((tree) => ({
        ...tree,
        hosts: tree.hosts.map((h) => (h.id === hostId ? { ...h, forwards: change(h.forwards) } : h)),
      }));
    return {
      tree: { groups: [], hosts: [] },
      status: "loading",
      error: null,

      async load() {
        try {
          set({ tree: await api.loadHostTree(), status: "ready", error: null });
        } catch (e) {
          set({ status: "error", error: readCommandError(e).message });
        }
      },

      async saveHost(draft, id) {
        const saved = await api.saveHost(draft, id);
        update((tree) => ({
          ...tree,
          hosts: tree.hosts.some((h) => h.id === saved.id)
            ? tree.hosts.map((h) => (h.id === saved.id ? saved : h))
            : [...tree.hosts, saved],
        }));
        return saved;
      },

      async deleteHost(id) {
        await api.deleteHost(id);
        update((tree) => ({ ...tree, hosts: tree.hosts.filter((h) => h.id !== id) }));
      },

      async duplicateHost(id, name) {
        const copy = await api.duplicateHost(id, name);
        update((tree) => {
          const hosts = [...tree.hosts];
          hosts.splice(hosts.findIndex((h) => h.id === id) + 1, 0, copy);
          return { ...tree, hosts };
        });
        return copy;
      },

      async move({ kind, id, parentId, index }) {
        const tree = kind === "host" ? await api.moveHost(id, parentId, index) : await api.moveGroup(id, parentId, index);
        set({ tree });
      },

      async createGroup(name, parentId) {
        const created = await api.createGroup(name, parentId);
        update((tree) => ({ ...tree, groups: [...tree.groups, created] }));
        return created;
      },

      async renameGroup(id, name) {
        const renamed = await api.renameGroup(id, name);
        update((tree) => ({ ...tree, groups: tree.groups.map((g) => (g.id === id ? renamed : g)) }));
        return renamed;
      },

      async deleteGroup(id) {
        set({ tree: await api.deleteGroup(id) });
      },

      async saveForward(hostId, draft, id) {
        const saved = await api.saveForward(hostId, draft, id);
        updateForwards(hostId, (forwards) =>
          forwards.some((f) => f.id === saved.id)
            ? forwards.map((f) => (f.id === saved.id ? saved : f))
            : [...forwards, saved],
        );
        return saved;
      },

      async deleteForward(hostId, id) {
        await api.deleteForward(hostId, id);
        updateForwards(hostId, (forwards) => forwards.filter((f) => f.id !== id));
      },
    };
  });
}

/** The app's hosts store, backed by the Tauri HostStore commands. */
export const hostsStore = createHostsStore(ipc);

export function useHosts<T>(selector: (state: HostsState) => T): T {
  return useStore(hostsStore, selector);
}
