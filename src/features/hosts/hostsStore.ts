import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { readCommandError } from "@/lib/ipc/connect";
import * as forwardsIpc from "@/lib/ipc/forwards";
import type { ForwardDraft, ForwardId, PortForward } from "@/lib/ipc/forwards";
import * as hostsIpc from "@/lib/ipc/hosts";
import type { Bookmark, Group, GroupId, Host, HostDraft, HostId, HostImportSource, HostOsChange, HostTree, ImportReport, ImportSummary } from "@/lib/ipc/hosts";
import { createSnapshotWatch } from "@/lib/ipc/watchSnapshot";
import type { MoveOp } from "./hostTree";

const ipc = { ...hostsIpc, ...forwardsIpc };

/** The HostStore commands the hosts store uses (`@/lib/ipc/hosts`, `@/lib/ipc/forwards`); a fake in tests. */
export type HostsApi = Pick<
  typeof ipc,
  | "loadHostTree"
  | "saveHost"
  | "saveTemporaryHost"
  | "deleteHost"
  | "addBookmark"
  | "renameBookmark"
  | "deleteBookmark"
  | "duplicateHost"
  | "moveHost"
  | "moveGroup"
  | "createGroup"
  | "renameGroup"
  | "deleteGroup"
  | "saveForward"
  | "deleteForward"
  | "importHostSource"
  | "exportHosts"
  | "importHosts"
>;

export interface HostsState {
  tree: HostTree;
  status: "loading" | "ready" | "error";
  /** Why the Host list could not be loaded (e.g. a damaged file). */
  error: string | null;
  load(): Promise<void>;
  /** Adds a Host (no `id`) at the top level, or saves edits to the Host with `id`. */
  saveHost(draft: HostDraft, id?: HostId): Promise<Host>;
  saveTemporaryHost(id: HostId, draft: HostDraft): Promise<Host>;
  addBookmark(hostId: HostId, path: string): Promise<void>;
  renameBookmark(hostId: HostId, path: string, name: string): Promise<void>;
  deleteBookmark(hostId: HostId, path: string): Promise<void>;
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
  /** Imports the chosen source and reports imported and skipped entries. */
  importHostSource(source: HostImportSource): Promise<ImportReport>;
  /** Writes the Host list to an export file (never credentials). */
  exportHosts(path: string): Promise<void>;
  /** Adds the Groups and Hosts of an export file; Hosts whose name is taken are skipped. */
  importHosts(path: string): Promise<ImportSummary>;
}

/**
 * The Host list as the UI sees it. Every change goes through the HostStore
 * first and is shown only once it is saved, so a refused change leaves the
 * list as it was; actions reject with the backend's `CommandError`.
 */
export function createHostsStore(api: HostsApi): StoreApi<HostsState> {
  return createStore<HostsState>()((set, get) => {
    const update = (change: (tree: HostTree) => HostTree) => set({ tree: change(get().tree) });
    // A command reply may describe the tree before an OS update just received on the channel.
    const osChanges = new Map<HostId, HostOsChange["detectedOs"]>();
    const withCurrentOs = (host: Host): Host => osChanges.has(host.id)
      ? { ...host, detectedOs: osChanges.get(host.id) ?? undefined }
      : host;
    // Other Host commands cannot change an existing Host's Bookmarks. Keep the
    // current list even if a Host or tree reply was produced before a Bookmark edit.
    const withCurrentBookmarks = (host: Host, current?: Host): Host => {
      if (!current || current.bookmarks === host.bookmarks) return host;
      const result = { ...host };
      if (current.bookmarks) result.bookmarks = current.bookmarks;
      else delete result.bookmarks;
      return result;
    };
    const replaceTree = (tree: HostTree) => {
      const current = new Map(get().tree.hosts.map((host) => [host.id, host]));
      set({ tree: { ...tree, hosts: tree.hosts.map((host) => withCurrentBookmarks(withCurrentOs(host), current.get(host.id))) } });
    };
    const watch = createSnapshotWatch<HostTree, HostOsChange>(
      api.loadHostTree,
      (tree) => {
        osChanges.clear();
        set({ tree, status: "ready", error: null });
      },
      ({ hostId, detectedOs }) => {
        osChanges.set(hostId, detectedOs);
        update((tree) => ({ ...tree, hosts: tree.hosts.map((host) => host.id === hostId ? withCurrentOs(host) : host) }));
      },
    );
    const publishHost = (saved: Host) => {
      const host = withCurrentBookmarks(withCurrentOs(saved), get().tree.hosts.find((h) => h.id === saved.id));
      update((tree) => ({
        ...tree,
        hosts: tree.hosts.some((h) => h.id === host.id)
          ? tree.hosts.map((h) => (h.id === host.id ? host : h))
          : [...tree.hosts, host],
      }));
      return host;
    };
    const updateForwards = (hostId: HostId, change: (forwards: PortForward[]) => PortForward[]) =>
      update((tree) => ({
        ...tree,
        hosts: tree.hosts.map((h) => (h.id === hostId ? { ...h, forwards: change(h.forwards) } : h)),
      }));
    // Serialize Bookmark writes and their replies across panels. A double add
    // preserves a name and a rename cannot overtake a pending delete.
    let bookmarkWrite = Promise.resolve();
    const updateBookmark = (hostId: HostId, path: string, write: () => Promise<Bookmark | void>) => {
      const written = bookmarkWrite.then(async () => {
        const saved = await write();
        update((tree) => ({ ...tree, hosts: tree.hosts.map((host) => {
          if (host.id !== hostId) return host;
          const bookmarks = [...(host.bookmarks ?? [])];
          const at = bookmarks.findIndex((bookmark) => bookmark.path === path);
          if (at === -1 && saved) bookmarks.push(saved);
          else if (at !== -1) {
            if (saved) bookmarks[at] = saved;
            else bookmarks.splice(at, 1);
          }
          return { ...host, bookmarks };
        }) }));
      });
      bookmarkWrite = written.catch(() => {});
      return written;
    };
    return {
      tree: { groups: [], hosts: [] },
      status: "loading",
      error: null,

      async load() {
        try {
          await watch();
        } catch (e) {
          set({ status: "error", error: readCommandError(e).message });
        }
      },

      async saveHost(draft, id) {
        return publishHost(await api.saveHost(draft, id));
      },

      async saveTemporaryHost(id, draft) {
        return publishHost(await api.saveTemporaryHost(id, draft));
      },

      addBookmark(hostId, path) {
        return updateBookmark(hostId, path, () => api.addBookmark(hostId, path));
      },

      renameBookmark(hostId, path, name) {
        return updateBookmark(hostId, path, () => api.renameBookmark(hostId, path, name));
      },

      deleteBookmark(hostId, path) {
        return updateBookmark(hostId, path, () => api.deleteBookmark(hostId, path));
      },

      async deleteHost(id) {
        await api.deleteHost(id);
        osChanges.delete(id);
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
        replaceTree(tree);
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
        replaceTree(await api.deleteGroup(id));
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

      async importHostSource(source) {
        const { tree, report } = await api.importHostSource(source);
        replaceTree(tree);
        return report;
      },

      exportHosts(path) {
        return api.exportHosts(path);
      },

      async importHosts(path) {
        const { summary, tree } = await api.importHosts(path);
        replaceTree(tree);
        return summary;
      },
    };
  });
}

/** The app's hosts store, backed by the Tauri HostStore commands. */
export const hostsStore = createHostsStore(ipc);

export function useHosts<T>(selector: (state: HostsState) => T): T {
  return useStore(hostsStore, selector);
}
