import { describe, expect, it, vi } from "vitest";
import type { FileEntry, Listing } from "@/lib/ipc/files";
import { createFileBrowserStore, followConnection, type FilesApi } from "./fileBrowserStore";

const entry = (name: string, kind: FileEntry["kind"] = "file"): FileEntry => ({
  name,
  kind,
  size: 1,
  modified: null,
  permissions: 0o644,
  linkTarget: null,
});

/** A Host with these directories; `""` is the home directory. */
const tree: Record<string, string[]> = {
  "/home/me": ["notes.txt", "src/"],
  "/home/me/src": ["main.rs", "lib.rs"],
  "/home": ["me/"],
};

/** A fake whose file operations change `dirs` (a copy of `tree` unless given). */
function fakeApi(overrides: Partial<FilesApi> = {}, dirs: Record<string, string[]> = structuredClone(tree)): FilesApi {
  const split = (path: string) => {
    const cut = path.lastIndexOf("/");
    return [path.slice(0, cut) || "/", path.slice(cut + 1)] as const;
  };
  const strip = (name: string) => name.replace(/\/$/, "");
  const find = (path: string) => {
    const [dir, name] = split(path);
    const index = (dirs[dir] ?? []).findIndex((n) => strip(n) === name);
    return { dir, name, index };
  };
  const taken = (path: string) => Promise.reject({ kind: "alreadyExists", message: "exists", details: { path } });
  return {
    openFiles: vi.fn(() => Promise.resolve(7)),
    listFiles: vi.fn((_id: number, path: string): Promise<Listing> => {
      const resolved = path === "" || path === "~" ? "/home/me" : path.replace(/\/$/, "");
      const names = dirs[resolved];
      if (!names) return Promise.reject({ kind: "notFound", message: `no such file: ${resolved}` });
      return Promise.resolve({
        path: resolved,
        entries: names.map((n) => (n.endsWith("/") ? entry(n.slice(0, -1), "dir") : entry(n))),
      });
    }),
    closeFiles: vi.fn(() => Promise.resolve()),
    createDir: vi.fn((_id: number, path: string) => {
      const { dir, name, index } = find(path);
      if (index >= 0) return taken(path);
      dirs[dir]?.push(`${name}/`);
      dirs[path] = [];
      return Promise.resolve();
    }),
    renameFile: vi.fn((_id: number, from: string, to: string) => {
      const source = find(from);
      const target = find(to);
      if (target.index >= 0) return taken(to);
      const old = dirs[source.dir]!.splice(source.index, 1)[0]!;
      dirs[target.dir]!.push(old.endsWith("/") ? `${target.name}/` : target.name);
      return Promise.resolve();
    }),
    countFiles: vi.fn((_id: number, paths: string[]) =>
      Promise.resolve(paths.reduce((n, p) => n + 1 + (dirs[p]?.length ?? 0), 0)),
    ),
    deleteFiles: vi.fn((_id: number, paths: string[]) => {
      for (const path of paths) {
        const { dir, index } = find(path);
        dirs[dir]!.splice(index, 1);
      }
      return Promise.resolve();
    }),
    chmodFile: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

async function connected(overrides?: Partial<FilesApi>) {
  const api = fakeApi(overrides);
  const store = createFileBrowserStore(api, "host-1");
  await store.getState().connect();
  return { api, store };
}

const shown = (store: Awaited<ReturnType<typeof connected>>["store"]) => ({
  path: store.getState().path,
  names: store.getState().entries.map((e) => e.name),
});

describe("fileBrowserStore", () => {
  it("opens over the Host's Connection at the home directory", async () => {
    const { api, store } = await connected();

    expect(api.openFiles).toHaveBeenCalledWith("host-1");
    expect(store.getState().phase).toBe("open");
    expect(shown(store)).toEqual({ path: "/home/me", names: ["notes.txt", "src"] });
  });

  it("goes to a typed path, into a directory and back up", async () => {
    const { store } = await connected();

    await store.getState().navigate("/home/me/src/");
    expect(shown(store).path).toBe("/home/me/src");

    await store.getState().up();
    expect(shown(store).path).toBe("/home/me");

    await store.getState().open(entry("src", "dir"));
    expect(shown(store).path).toBe("/home/me/src");
    await store.getState().open(entry("main.rs"));
    expect(shown(store).path).toBe("/home/me/src");
  });

  it("keeps showing the current directory when a path cannot be opened", async () => {
    const { store } = await connected();

    await store.getState().navigate("/nope");

    expect(shown(store).path).toBe("/home/me");
    expect(store.getState().error).toMatchObject({ kind: "notFound" });
    await store.getState().refresh();
    expect(store.getState().error).toBeNull();
  });

  it("shows only the latest of overlapping navigations", async () => {
    let releaseSlow: () => void = () => {};
    const api = fakeApi();
    const list = api.listFiles;
    const { store } = await connected({
      listFiles: vi.fn((id: number, path: string) =>
        path === "/home"
          ? new Promise<Listing>((resolve) => {
              releaseSlow = () => void list(id, path).then(resolve);
            })
          : list(id, path),
      ),
    });

    const slow = store.getState().navigate("/home");
    await store.getState().navigate("/home/me/src");
    releaseSlow();
    await slow;

    expect(shown(store).path).toBe("/home/me/src");
    expect(store.getState().loading).toBe(false);
  });

  it("selects one, toggles, and extends a range in display order", async () => {
    const { store } = await connected();
    const order = ["a", "b", "c", "d"];
    const selected = () => [...store.getState().selection].sort();

    store.getState().select("b", "only", order);
    expect(selected()).toEqual(["b"]);
    store.getState().select("d", "toggle", order);
    expect(selected()).toEqual(["b", "d"]);
    store.getState().select("d", "toggle", order);
    expect(selected()).toEqual(["b"]);
    // A range runs from the last plainly clicked or toggled row.
    store.getState().select("b", "only", order);
    store.getState().select("d", "range", order);
    expect(selected()).toEqual(["b", "c", "d"]);
    store.getState().select("a", "range", order);
    expect(selected()).toEqual(["a", "b"]);
  });

  it("clears the selection in a new directory and keeps what still exists on refresh", async () => {
    const { store } = await connected();
    store.getState().select("notes.txt", "only", ["notes.txt", "src"]);

    await store.getState().refresh();
    expect([...store.getState().selection]).toEqual(["notes.txt"]);

    await store.getState().navigate("/home/me/src");
    expect(store.getState().selection.size).toBe(0);
  });

  it("closes its SFTP session on disconnect and reopens where it was", async () => {
    const { api, store } = await connected();
    await store.getState().navigate("/home/me/src");

    store.getState().disconnect();
    expect(api.closeFiles).toHaveBeenCalledWith(7);
    expect(store.getState().phase).toBe("closed");

    await store.getState().connect();
    expect(api.openFiles).toHaveBeenCalledTimes(2);
    expect(shown(store).path).toBe("/home/me/src");
  });

  it("reports a Host without a Connection and can try again", async () => {
    const openFiles = vi
      .fn<FilesApi["openFiles"]>()
      .mockRejectedValueOnce({ kind: "notConnected", message: "not connected" })
      .mockResolvedValue(3);
    const { store } = await connected({ openFiles });

    expect(store.getState().phase).toBe("closed");
    expect(store.getState().error).toMatchObject({ kind: "notConnected" });

    await store.getState().connect();
    expect(store.getState().phase).toBe("open");
    expect(store.getState().error).toBeNull();
  });

  it("connects once even when asked twice at the same time", async () => {
    const api = fakeApi();
    const store = createFileBrowserStore(api, "host-1");

    await Promise.all([store.getState().connect(), store.getState().connect()]);

    expect(api.openFiles).toHaveBeenCalledTimes(1);
  });
});

describe("file operations", () => {
  const selected = (store: Awaited<ReturnType<typeof connected>>["store"]) => [...store.getState().selection];

  it("creates a folder in the directory shown and selects it", async () => {
    const { api, store } = await connected();

    expect(await store.getState().createFolder("build")).toBeNull();

    expect(api.createDir).toHaveBeenCalledWith(7, "/home/me/build");
    expect(shown(store).names).toContain("build");
    expect(selected(store)).toEqual(["build"]);
  });

  it("renames an entry and keeps it selected under its new name", async () => {
    const { api, store } = await connected();
    store.getState().select("notes.txt", "only", ["notes.txt", "src"]);

    expect(await store.getState().rename("notes.txt", "todo.txt")).toBeNull();

    expect(api.renameFile).toHaveBeenCalledWith(7, "/home/me/notes.txt", "/home/me/todo.txt");
    expect(shown(store).names.sort()).toEqual(["src", "todo.txt"]);
    expect(selected(store)).toEqual(["todo.txt"]);
  });

  it("hands back why an operation failed, leaving the listing and its error alone", async () => {
    const { store } = await connected();

    const failure = await store.getState().rename("notes.txt", "src");

    expect(failure).toMatchObject({ kind: "alreadyExists", details: { path: "/home/me/src" } });
    expect(store.getState().error).toBeNull();
    expect(shown(store).names.sort()).toEqual(["notes.txt", "src"]);
  });

  it("counts what deleting the selection removes, then deletes it", async () => {
    const { api, store } = await connected();

    // src itself and its two files, plus notes.txt.
    expect(await store.getState().countForDelete(["src", "notes.txt"])).toEqual({ count: 4 });
    expect(await store.getState().remove(["src", "notes.txt"])).toBeNull();

    expect(api.deleteFiles).toHaveBeenCalledWith(7, ["/home/me/src", "/home/me/notes.txt"]);
    expect(shown(store).names).toEqual([]);
    expect(selected(store)).toEqual([]);
  });

  it("refreshes after a delete that stopped half way, showing what is left", async () => {
    const { store } = await connected({
      deleteFiles: vi.fn(() => Promise.reject({ kind: "permissionDenied", message: "no", details: { path: "/x" } })),
    });

    expect(await store.getState().remove(["notes.txt"])).toMatchObject({ kind: "permissionDenied" });
    expect(shown(store).names.sort()).toEqual(["notes.txt", "src"]);
  });

  it("changes an entry's permissions and refreshes", async () => {
    const { api, store } = await connected();

    expect(await store.getState().setPermissions("notes.txt", 0o600)).toBeNull();

    expect(api.chmodFile).toHaveBeenCalledWith(7, "/home/me/notes.txt", 0o600);
    expect(api.listFiles).toHaveBeenCalledTimes(2);
  });
});

describe("followConnection", () => {
  it("opens SFTP only once the Terminal is connected and the panel is shown", async () => {
    const api = fakeApi();
    const store = createFileBrowserStore(api, "host-1");
    followConnection(store, "connecting", true);
    followConnection(store, "connected", false);
    expect(api.openFiles).not.toHaveBeenCalled();
    followConnection(store, "connected", true);
    await vi.waitFor(() => expect(store.getState().phase).toBe("open"));
    expect(api.openFiles).toHaveBeenCalledTimes(1);
  });

  it("reopens SFTP on the new Connection after a reconnect, at the same path", async () => {
    let next = 7;
    const { api, store } = await connected({ openFiles: vi.fn(() => Promise.resolve(next++)) });
    await store.getState().navigate("/home/me/src");

    followConnection(store, "connecting", true);
    expect(store.getState().phase).toBe("closed");
    expect(api.closeFiles).toHaveBeenCalledWith(7);

    followConnection(store, "connected", true);
    await vi.waitFor(() => expect(store.getState().phase).toBe("open"));
    expect(api.openFiles).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(api.listFiles).toHaveBeenLastCalledWith(8, "/home/me/src"));
    expect(shown(store).path).toBe("/home/me/src");
  });

  it("shows the open failure (with a retry) when the Host has no live Connection", async () => {
    const api = fakeApi({ openFiles: vi.fn(() => Promise.reject({ kind: "notConnected", message: "not connected" })) });
    const store = createFileBrowserStore(api, "host-1");
    followConnection(store, "connected", true);
    await vi.waitFor(() => expect(store.getState().error?.kind).toBe("notConnected"));
    expect(store.getState().phase).toBe("closed");
  });
});
