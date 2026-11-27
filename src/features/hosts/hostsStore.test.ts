import { describe, expect, it, vi } from "vitest";
import type { ForwardDraft, PortForward } from "@/lib/ipc/forwards";
import type { Group, Host, HostDraft, HostTree } from "@/lib/ipc/hosts";
import { createHostsStore, type HostsApi } from "./hostsStore";

const draft = (name: string): HostDraft => ({
  name,
  address: "10.0.0.5",
  port: 22,
  user: "deploy",
  auth: { type: "password" },
  jumpHost: null,
});
const host = (id: string, groupId: string | null = null): Host => ({ ...draft(id), id, groupId, forwards: [] });
const group = (id: string, parentId: string | null = null): Group => ({ id, name: id, parentId });

/** An API whose every call resolves with a canned answer; override per test. */
function fakeApi(initial: HostTree, overrides: Partial<HostsApi> = {}): HostsApi {
  let forwards = 0;
  return {
    loadHostTree: vi.fn(() => Promise.resolve(initial)),
    saveHost: vi.fn((d: HostDraft, id?: string) => Promise.resolve({ ...d, id: id ?? "new", groupId: null, forwards: [] })),
    saveTemporaryHost: vi.fn((id: string, d: HostDraft) => Promise.resolve({ ...d, id, groupId: null, forwards: [] })),
    deleteHost: vi.fn(() => Promise.resolve()),
    duplicateHost: vi.fn((id: string, name: string) =>
      Promise.resolve({ ...initial.hosts.find((h) => h.id === id)!, id: "copy", name }),
    ),
    moveHost: vi.fn(() => Promise.resolve(initial)),
    moveGroup: vi.fn(() => Promise.resolve(initial)),
    createGroup: vi.fn((name: string, parentId: string | null) => Promise.resolve({ id: "g-new", name, parentId })),
    renameGroup: vi.fn((id: string, name: string) => Promise.resolve({ ...initial.groups.find((g) => g.id === id)!, name })),
    deleteGroup: vi.fn(() => Promise.resolve(initial)),
    saveForward: vi.fn((_host: string, d: ForwardDraft, id?: string) => Promise.resolve({ ...d, id: id ?? `f${++forwards}` })),
    deleteForward: vi.fn(() => Promise.resolve()),
    importSshConfig: vi.fn(() => Promise.resolve({ tree: initial, report: { imported: [], skipped: [], issues: [], proxyCommands: [] } })),
    exportHosts: vi.fn(() => Promise.resolve()),
    importHosts: vi.fn(() =>
      Promise.resolve({ summary: { hostsAdded: 0, groupsAdded: 0, skippedHosts: [] }, tree: initial }),
    ),
    ...overrides,
  };
}

const ids = (tree: HostTree) => ({ groups: tree.groups.map((g) => g.name), hosts: tree.hosts.map((h) => h.name) });

async function loaded(tree: HostTree, overrides?: Partial<HostsApi>) {
  const api = fakeApi(tree, overrides);
  const store = createHostsStore(api);
  await store.getState().load();
  return { api, store };
}

describe("hosts store", () => {
  it("loads the Host tree", async () => {
    const { store } = await loaded({ groups: [group("prod")], hosts: [host("a", "prod")] });
    expect(store.getState().status).toBe("ready");
    expect(ids(store.getState().tree)).toEqual({ groups: ["prod"], hosts: ["a"] });
  });

  it("shows live OS changes without overwriting a concurrent Host edit", async () => {
    const original = host("a");
    const { store } = await loaded({ groups: [], hosts: [original] }, {
      async loadHostTree(receive) {
        receive?.({ hostId: original.id, detectedOs: "debian" });
        return { groups: [], hosts: [original] };
      },
    });

    expect(store.getState().tree.hosts[0].detectedOs).toBe("debian");
    await store.getState().saveHost({ ...draft("new name"), icon: "router" }, original.id);
    expect(store.getState().tree.hosts[0]).toMatchObject({ name: "new name", icon: "router", detectedOs: "debian" });
  });

  it("keeps the load error to show instead of the list", async () => {
    const { store } = await loaded(
      { groups: [], hosts: [] },
      { loadHostTree: () => Promise.reject({ kind: "hostStoreCorrupt", message: "damaged" }) },
    );
    expect(store.getState()).toMatchObject({ status: "error", error: "damaged" });
  });

  it("adds a new Host at the end and edits an existing one in place", async () => {
    const { store, api } = await loaded({ groups: [], hosts: [host("a"), host("b")] });

    await store.getState().saveHost(draft("c"));
    await store.getState().saveHost(draft("a2"), "a");

    expect(api.saveHost).toHaveBeenLastCalledWith(draft("a2"), "a");
    expect(ids(store.getState().tree).hosts).toEqual(["a2", "b", "c"]);
  });

  it("removes a deleted Host", async () => {
    const { store, api } = await loaded({ groups: [], hosts: [host("a"), host("b")] });
    await store.getState().deleteHost("a");
    expect(api.deleteHost).toHaveBeenCalledWith("a");
    expect(ids(store.getState().tree).hosts).toEqual(["b"]);
  });

  it("puts a duplicate right after the original", async () => {
    const { store, api } = await loaded({ groups: [], hosts: [host("a"), host("b")] });
    const copy = await store.getState().duplicateHost("a", "a copy");
    expect(api.duplicateHost).toHaveBeenCalledWith("a", "a copy");
    expect(copy.id).toBe("copy");
    expect(ids(store.getState().tree).hosts).toEqual(["a", "a copy", "b"]);
  });

  it("moves Hosts and Groups through the HostStore and shows the order it saved", async () => {
    const after: HostTree = { groups: [group("prod")], hosts: [host("b"), host("a", "prod")] };
    const { store, api } = await loaded(
      { groups: [group("prod")], hosts: [host("a"), host("b")] },
      { moveHost: vi.fn(() => Promise.resolve(after)) },
    );

    await store.getState().move({ kind: "host", id: "a", parentId: "prod", index: 0 });
    expect(api.moveHost).toHaveBeenCalledWith("a", "prod", 0);
    expect(store.getState().tree).toEqual(after);

    await store.getState().move({ kind: "group", id: "prod", parentId: null, index: 0 });
    expect(api.moveGroup).toHaveBeenCalledWith("prod", null, 0);
  });

  it("creates, renames and deletes Groups", async () => {
    const afterDelete: HostTree = { groups: [], hosts: [host("a")] };
    const { store, api } = await loaded(
      { groups: [group("prod")], hosts: [host("a", "prod")] },
      { deleteGroup: vi.fn(() => Promise.resolve(afterDelete)) },
    );

    const created = await store.getState().createGroup("web", "prod");
    expect(created).toEqual({ id: "g-new", name: "web", parentId: "prod" });
    await store.getState().renameGroup("prod", "Production");
    expect(ids(store.getState().tree).groups).toEqual(["Production", "web"]);

    await store.getState().deleteGroup("prod");
    expect(api.deleteGroup).toHaveBeenCalledWith("prod");
    expect(store.getState().tree).toEqual(afterDelete);
  });

  it("leaves the list as it was when the HostStore refuses a change", async () => {
    const before: HostTree = { groups: [group("prod")], hosts: [host("a")] };
    const refusal = { kind: "invalidMove", message: "no" };
    const { store } = await loaded(before, {
      moveGroup: () => Promise.reject(refusal),
      deleteHost: () => Promise.reject(refusal),
    });

    await expect(store.getState().move({ kind: "group", id: "prod", parentId: "prod", index: 0 })).rejects.toBe(refusal);
    await expect(store.getState().deleteHost("a")).rejects.toBe(refusal);
    expect(store.getState().tree).toEqual(before);
  });

  it("adds, edits and deletes a Host's Port forwards", async () => {
    const { store, api } = await loaded({ groups: [], hosts: [host("a"), host("b")] });
    const rule: ForwardDraft = {
      label: "",
      autoStart: false,
      type: "local",
      bindAddress: "127.0.0.1",
      bindPort: 8080,
      remoteHost: "web",
      remotePort: 80,
    };
    const forwardsOf = (id: string) => store.getState().tree.hosts.find((h) => h.id === id)!.forwards;

    const added: PortForward = await store.getState().saveForward("a", rule);
    await store.getState().saveForward("a", { ...rule, bindPort: 8443 });
    await store.getState().saveForward("a", { ...rule, bindPort: 9090 }, added.id);

    expect(api.saveForward).toHaveBeenLastCalledWith("a", { ...rule, bindPort: 9090 }, "f1");
    expect(forwardsOf("a").map((f) => f.bindPort)).toEqual([9090, 8443]);
    expect(forwardsOf("b")).toEqual([]);

    await store.getState().deleteForward("a", added.id);
    expect(api.deleteForward).toHaveBeenCalledWith("a", "f1");
    expect(forwardsOf("a").map((f) => f.bindPort)).toEqual([8443]);
  });

  it("shows the Hosts an ~/.ssh/config import saved and returns its report", async () => {
    const imported = { groups: [], hosts: [host("a"), host("web"), host("db")] };
    const report = {
      imported: ["web", "db"],
      skipped: ["a"],
      issues: [{ entry: "legacy", dropped: true, problem: { kind: "invalidValue" as const, directive: "Port", value: "nope" } }],
      proxyCommands: [{ host: "web", command: "nc %h %p" }],
    };
    const { store } = await loaded(
      { groups: [], hosts: [host("a")] },
      { importSshConfig: () => Promise.resolve({ tree: imported, report }) },
    );

    expect(await store.getState().importSshConfig()).toEqual(report);
    expect(ids(store.getState().tree).hosts).toEqual(["a", "web", "db"]);
  });

  it("shows the Host list the HostStore saved after an import", async () => {
    const after = { groups: [group("prod")], hosts: [host("a"), host("b", "prod")] };
    const summary = { hostsAdded: 1, groupsAdded: 1, skippedHosts: ["a"] };
    const { api, store } = await loaded(
      { groups: [], hosts: [host("a")] },
      { importHosts: vi.fn(() => Promise.resolve({ summary, tree: after })) },
    );

    await expect(store.getState().importHosts("/tmp/hosts.json")).resolves.toEqual(summary);

    expect(api.importHosts).toHaveBeenCalledWith("/tmp/hosts.json");
    expect(ids(store.getState().tree)).toEqual({ groups: ["prod"], hosts: ["a", "b"] });
  });

  it("keeps the list as it was when an import fails", async () => {
    const { store } = await loaded(
      { groups: [], hosts: [host("a")] },
      { importHosts: () => Promise.reject({ kind: "hostStoreCorrupt", message: "damaged" }) },
    );

    await expect(store.getState().importHosts("/tmp/x.json")).rejects.toMatchObject({ kind: "hostStoreCorrupt" });
    expect(ids(store.getState().tree)).toEqual({ groups: [], hosts: ["a"] });
  });

  it("exports through the HostStore", async () => {
    const { api, store } = await loaded({ groups: [], hosts: [host("a")] });
    await store.getState().exportHosts("/tmp/out.json");
    expect(api.exportHosts).toHaveBeenCalledWith("/tmp/out.json");
  });
});
