import { describe, expect, it, vi } from "vitest";
import type { EditEvent } from "@/lib/ipc/edit";
import type { FileEntry, Listing } from "@/lib/ipc/files";
import { createFileBrowserStore, followConnection, type FilesApi } from "./fileBrowserStore";
import { createFileBrowsers } from "./fileBrowsers";
import { createSharedRemoteEdits } from "./sharedRemoteEdits";

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
    openRemoteEdit: vi.fn((_host: string, _path: string, onEvent: (event: EditEvent) => void) => {
      editEvents = onEvent;
      return Promise.resolve(42);
    }),
    retryRemoteEdit: vi.fn(() => Promise.resolve()),
    closeRemoteEdit: vi.fn(() => Promise.resolve()),
    overwriteRemoteEdit: vi.fn(() => Promise.resolve()),
    openRemoteEditConflictCopy: vi.fn(() => Promise.resolve(43)),
    createDir: vi.fn((_id: number, path: string) => {
      const { dir, name, index } = find(path);
      if (index >= 0) return taken(path);
      dirs[dir]?.push(`${name}/`);
      dirs[path] = [];
      return Promise.resolve();
    }),
    compressFiles: vi.fn(() => Promise.resolve()),
    extractArchive: vi.fn(() => Promise.resolve()),
    createEmptyFile: vi.fn((_id: number, path: string) => {
      const { dir, name, index } = find(path);
      if (index >= 0) return taken(path);
      dirs[dir]!.push(name);
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
    folderSize: vi.fn(() => Promise.resolve(0)),
    searchNames: vi.fn(() => Promise.resolve(null)),
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

/** The event callback of the last remote edit opened through `fakeApi`. */
let editEvents: (event: EditEvent) => void = () => {};

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
  it("offers only one ordinary file from the current remote listing for drag out", async () => {
    const { store } = await connected({ listFiles: vi.fn(async (): Promise<Listing> => ({
      path: "/home/me",
      entries: [entry("資料.txt"), entry("folder", "dir"), { ...entry("alias", "symlink"), linkTarget: "file" }],
    })) });

    expect(store.getState().filePromise("/home/me", ["資料.txt"])).toEqual({
      id: 7, directory: "/home/me", name: "資料.txt", size: 1, modified: null,
    });
    expect(store.getState().filePromise("/home/me", ["자료.txt"])).toBeNull();
    expect(store.getState().filePromise("/home/me", ["資料.txt", "folder"])).toBeNull();
    expect(store.getState().filePromise("/home/me", ["alias"])).toBeNull();
    expect(store.getState().filePromise("/home/me", ["folder"])).toBeNull();
    expect(store.getState().filePromise("/home/old", ["資料.txt"])).toBeNull();
    store.getState().disconnect();
    expect(store.getState().filePromise("/home/me", ["資料.txt"])).toBeNull();
  });

  it("refreshes the source and destination views when pasting cut entries into another folder", async () => {
    const browsers = createFileBrowsers(fakeApi());
    const panel = browsers.get("moving", "host-1");
    const source = browsers.get("source", "host-1");
    const unrelated = browsers.get("unrelated", "host-2");
    await Promise.all([panel.getState().connect(), source.getState().connect(), unrelated.getState().connect()]);

    panel.getState().cutEntries(["notes.txt"]);
    await panel.getState().navigate("/home/me/src");
    expect(await panel.getState().pasteCutEntries()).toEqual([]);

    expect(shown(panel)).toEqual({ path: "/home/me/src", names: ["main.rs", "lib.rs", "notes.txt"] });
    expect(shown(source)).toEqual({ path: "/home/me", names: ["src"] });
    expect(shown(unrelated)).toEqual({ path: "/home/me", names: ["notes.txt", "src"] });
    expect(panel.getState().cut).toBeNull();
  });

  it("preserves both entries on a name conflict and keeps only failed cuts available for retry", async () => {
    const dirs = {
      "/home/me": ["notes.txt", "draft.txt", "locked.txt", "src/"],
      "/home/me/src": ["notes.txt"],
    };
    const api = fakeApi({}, dirs);
    const rename = api.renameFile;
    api.renameFile = (id, from, to) => from.endsWith("/locked.txt")
      ? Promise.reject({ kind: "permissionDenied", message: "denied", details: { path: from } })
      : rename(id, from, to);
    const store = createFileBrowserStore(api, "host-1");
    await store.getState().connect();
    store.getState().cutEntries(["notes.txt", "draft.txt", "locked.txt"]);
    await store.getState().navigate("/home/me/src");

    expect(await store.getState().pasteCutEntries()).toMatchObject([
      { name: "notes.txt", error: { kind: "alreadyExists", details: { path: "/home/me/src/notes.txt" } } },
      { name: "locked.txt", error: { kind: "permissionDenied" } },
    ]);

    expect(store.getState().cut?.names).toEqual(["notes.txt", "locked.txt"]);
    expect(store.getState().error).toBeNull();
    expect(shown(store).names).toEqual(["notes.txt", "draft.txt"]);
    await store.getState().goBack();
    expect(shown(store).names).toEqual(["notes.txt", "locked.txt", "src"]);
  });

  it("finishes navigation before refreshing a directory whose listing was in flight during the move", async () => {
    const api = fakeApi();
    const browsers = createFileBrowsers(api);
    const moving = browsers.get("moving", "host-1");
    const browsing = browsers.get("browsing", "host-1");
    await Promise.all([moving.getState().connect(), browsing.getState().connect()]);
    moving.getState().cutEntries(["notes.txt"]);
    await moving.getState().navigate("/home/me/src");

    const snapshot = await api.listFiles(7, "/home/me/src");
    let finishListing!: () => void;
    vi.mocked(api.listFiles).mockImplementationOnce(() => new Promise((resolve) => {
      finishListing = () => resolve(snapshot);
    }));
    const navigation = browsing.getState().navigate("/home/me/src");
    await moving.getState().pasteCutEntries();
    finishListing();
    await navigation;

    expect(shown(browsing)).toEqual({ path: "/home/me/src", names: ["main.rs", "lib.rs", "notes.txt"] });
  });

  it("opens over the Host's Connection at the home directory", async () => {
    const { api, store } = await connected();

    expect(api.openFiles).toHaveBeenCalledWith("host-1");
    expect(store.getState().phase).toBe("open");
    expect(shown(store)).toEqual({ path: "/home/me", names: ["notes.txt", "src"] });
  });

  it("opens first in the Host's default directory, and stays where it was after a reconnect", async () => {
    const api = fakeApi();
    const store = createFileBrowserStore(api, "host-1", "/home/me/src");

    await store.getState().connect();
    expect(shown(store).path).toBe("/home/me/src");

    await store.getState().navigate("/home");
    store.getState().disconnect();
    await store.getState().connect();
    expect(shown(store).path).toBe("/home");
  });

  it("opens in the home directory when the default directory is gone", async () => {
    const store = createFileBrowserStore(fakeApi(), "host-1", "/srv/gone");

    await store.getState().connect();

    expect(shown(store).path).toBe("/home/me");
    expect(store.getState().error).toBeNull();
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

  it("goes back and forward, replacing forward history after a new navigation", async () => {
    const { store } = await connected();
    const availability = () => [store.getState().canGoBack, store.getState().canGoForward];
    expect(availability()).toEqual([false, false]);

    await store.getState().open(entry("src", "dir"));
    await store.getState().up();
    expect(availability()).toEqual([true, false]);

    await store.getState().goBack();
    expect(shown(store).path).toBe("/home/me/src");
    expect(availability()).toEqual([true, true]);
    await store.getState().goForward();
    expect(shown(store).path).toBe("/home/me");

    await store.getState().goBack();
    await store.getState().navigate("/home");
    expect(availability()).toEqual([true, false]);
    await store.getState().goForward();
    expect(shown(store).path).toBe("/home");
    await store.getState().goBack();
    expect(shown(store).path).toBe("/home/me/src");
  });

  it("keeps each panel's history through errors, refreshes and reconnects", async () => {
    const { api, store } = await connected();
    const otherPanel = createFileBrowserStore(api, "host-1");
    await otherPanel.getState().connect();
    await store.getState().navigate("/home/me/src");
    expect(otherPanel.getState().canGoBack).toBe(false);

    await store.getState().goBack();
    await store.getState().navigate("/missing");
    expect(store.getState().error?.kind).toBe("notFound");
    expect(store.getState().canGoForward).toBe(true);

    await store.getState().refresh();
    store.getState().disconnect();
    await store.getState().connect();
    expect(store.getState().canGoBack).toBe(false);
    await store.getState().goForward();
    expect(shown(store).path).toBe("/home/me/src");
    expect(shown(otherPanel).path).toBe("/home/me");
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
    await store.getState().goBack();
    expect(shown(store).path).toBe("/home/me");
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

describe("remote editing", () => {
  const edits = (store: Awaited<ReturnType<typeof connected>>["store"]) =>
    store.getState().edits.map(({ name, status }) => ({ name, status }));

  it("opens a file in the editor and follows its uploads", async () => {
    const { api, store } = await connected();

    await store.getState().open(entry("notes.txt"));

    expect(api.openRemoteEdit).toHaveBeenCalledWith("host-1", "/home/me/notes.txt", expect.any(Function), {
      allowBinary: false,
    });
    expect(shown(store).path).toBe("/home/me");
    expect(edits(store)).toEqual([{ name: "notes.txt", status: "editing" }]);
    editEvents({ state: "uploading" });
    expect(edits(store)).toEqual([{ name: "notes.txt", status: "uploading" }]);
    editEvents({ state: "uploaded" });
    expect(edits(store)).toEqual([{ name: "notes.txt", status: "uploaded" }]);
  });

  it("opens a link to a file, but not other kinds", async () => {
    const { api, store } = await connected();

    await store.getState().open({ ...entry("link"), kind: "symlink", linkTarget: "file" });
    await store.getState().open({ ...entry("dangling"), kind: "symlink", linkTarget: null });
    await store.getState().open(entry("socket", "other"));

    expect(api.openRemoteEdit).toHaveBeenCalledTimes(1);
    expect(edits(store)).toEqual([{ name: "link", status: "editing" }]);
  });

  it("shows a failed upload and retries it", async () => {
    const { api, store } = await connected();
    await store.getState().open(entry("notes.txt"));

    editEvents({ state: "uploadFailed", reason: "connection lost" });
    expect(store.getState().edits[0]).toMatchObject({
      status: "uploadFailed",
      error: { message: "connection lost" },
    });

    await store.getState().retryEdit("/home/me/notes.txt");
    expect(api.retryRemoteEdit).toHaveBeenCalledWith(42);
    expect(store.getState().edits[0]).toMatchObject({ status: "uploading", error: null });
  });

  it("reports a failed upload once for an edit shared by two File panels", async () => {
    const api = fakeApi();
    const failures: string[] = [];
    const editsForPanel = createSharedRemoteEdits(api, (name, reason) => failures.push(`${name}: ${reason}`));
    const browsers = createFileBrowsers(api, editsForPanel);
    const first = browsers.get("one", "host-1").getState();
    const second = browsers.get("two", "host-1").getState();
    await Promise.all([first.connect(), second.connect()]);
    await first.open(entry("notes.txt"));
    await second.open(entry("notes.txt"));

    editEvents({ state: "uploadFailed", reason: "connection lost" });
    first.closeEdit("/home/me/notes.txt");
    second.closeEdit("/home/me/notes.txt");
    editEvents({ state: "uploadFailed", reason: "closed edit" });
    expect(failures).toEqual(["notes.txt: connection lost"]);
  });

  it("closes both edits when the last File panel closes while opening the remote version", async () => {
    let finishOpen!: (id: number) => void;
    const { api, store } = await connected({
      openRemoteEditConflictCopy: () => new Promise((resolve) => { finishOpen = resolve; }),
    });
    await store.getState().open(entry("notes.txt"));
    editEvents({ state: "conflict", conflictId: 8 });

    const opening = store.getState().resolveEditConflict("/home/me/notes.txt", "openRemote");
    store.getState().dispose();
    finishOpen(43);
    await opening;

    expect(api.closeRemoteEdit).toHaveBeenCalledWith(42);
    expect(api.closeRemoteEdit).toHaveBeenCalledWith(43);
    expect(store.getState().edits).toEqual([]);
  });

  it("shows a file that could not be opened and tries again", async () => {
    const openRemoteEdit = vi
      .fn<FilesApi["openRemoteEdit"]>()
      .mockRejectedValueOnce({ kind: "permissionDenied", message: "denied", details: { path: "/home/me/notes.txt" } })
      .mockResolvedValue(9);
    const { store } = await connected({ openRemoteEdit });

    await store.getState().open(entry("notes.txt"));
    expect(store.getState().edits[0]).toMatchObject({ status: "openFailed", error: { kind: "permissionDenied" } });

    await store.getState().retryEdit("/home/me/notes.txt");
    expect(openRemoteEdit).toHaveBeenCalledTimes(2);
    expect(store.getState().edits[0]).toMatchObject({ id: 9, status: "editing", error: null });
  });

  it("lists a file opened twice once", async () => {
    const { store } = await connected();

    await store.getState().open(entry("notes.txt"));
    editEvents({ state: "uploaded" });
    await store.getState().open(entry("notes.txt"));

    expect(edits(store)).toEqual([{ name: "notes.txt", status: "uploaded" }]);
  });

  it("closes an edit, and all of them when the panel goes away", async () => {
    const { api, store } = await connected({
      openRemoteEdit: vi.fn((_h: string, path: string) => Promise.resolve(path.endsWith("notes.txt") ? 1 : 2)),
    });
    await store.getState().open(entry("notes.txt"));
    await store.getState().navigate("/home/me/src");
    await store.getState().open(entry("main.rs"));

    store.getState().closeEdit("/home/me/notes.txt");
    expect(api.closeRemoteEdit).toHaveBeenCalledWith(1);
    expect(edits(store)).toEqual([{ name: "main.rs", status: "editing" }]);

    store.getState().dispose();
    expect(api.closeRemoteEdit).toHaveBeenCalledWith(2);
    expect(api.closeFiles).toHaveBeenCalled();
    expect(edits(store)).toEqual([]);
  });

  it("asks instead of opening a file over the size limit, so it can be downloaded", async () => {
    const { api, store } = await connected();

    await store.getState().open({ ...entry("dump.sql"), size: 10 * 1024 * 1024 + 1 });

    expect(api.openRemoteEdit).not.toHaveBeenCalled();
    expect(edits(store)).toEqual([]);
    expect(store.getState().editQuestion).toEqual({ path: "/home/me/dump.sql", name: "dump.sql", reason: "tooLarge" });

    store.getState().answerEditQuestion("cancel");
    expect(store.getState().editQuestion).toBeNull();
  });

  it("asks when the file turns out larger than the limit on the server", async () => {
    const { store } = await connected({
      openRemoteEdit: vi.fn(() => Promise.reject({ kind: "tooLarge", message: "big", details: { path: "x" } })),
    });

    await store.getState().open(entry("notes.txt"));

    expect(edits(store)).toEqual([]);
    expect(store.getState().editQuestion).toMatchObject({ reason: "tooLarge" });
  });

  it("asks before opening a file that looks binary, and opens it when told to", async () => {
    const openRemoteEdit = vi
      .fn<FilesApi["openRemoteEdit"]>()
      .mockRejectedValueOnce({ kind: "binary", message: "binary" })
      .mockResolvedValue(9);
    const { store } = await connected({ openRemoteEdit });

    await store.getState().open(entry("tool"));
    expect(edits(store)).toEqual([]);
    expect(store.getState().editQuestion).toEqual({ path: "/home/me/tool", name: "tool", reason: "binary" });

    await store.getState().answerEditQuestion("open");
    expect(openRemoteEdit).toHaveBeenLastCalledWith("host-1", "/home/me/tool", expect.any(Function), {
      allowBinary: true,
    });
    expect(store.getState().editQuestion).toBeNull();
    expect(edits(store)).toEqual([{ name: "tool", status: "editing" }]);
  });

  it("keeps editing while the Connection is down", async () => {
    const { api, store } = await connected();
    await store.getState().open(entry("notes.txt"));

    followConnection(store, "connecting", true);

    expect(api.closeRemoteEdit).not.toHaveBeenCalled();
    expect(edits(store)).toEqual([{ name: "notes.txt", status: "editing" }]);
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

  it("refreshes and selects a newly created file in the directory shown", async () => {
    const { store } = await connected();
    await store.getState().navigate("/home/me/src");

    expect(await store.getState().createFile("todo.txt")).toBeNull();

    expect(shown(store)).toEqual({ path: "/home/me/src", names: ["main.rs", "lib.rs", "todo.txt"] });
    expect(selected(store)).toEqual(["todo.txt"]);
  });

  it("renames an entry and keeps it selected under its new name", async () => {
    const { api, store } = await connected();
    store.getState().select("notes.txt", "only", ["notes.txt", "src"]);

    expect(await store.getState().rename("notes.txt", "todo.txt")).toBeNull();

    expect(api.renameFile).toHaveBeenCalledWith(7, "/home/me/notes.txt", "/home/me/todo.txt");
    expect(shown(store).names.sort()).toEqual(["src", "todo.txt"]);
    expect(selected(store)).toEqual(["todo.txt"]);
  });

  it("returns create and rename conflicts while preserving an existing listing error", async () => {
    const { store } = await connected();
    await store.getState().navigate("/missing");
    const listingError = store.getState().error;
    expect(listingError).toMatchObject({ kind: "notFound" });

    expect(await store.getState().rename("notes.txt", "src")).toMatchObject({
      kind: "alreadyExists", details: { path: "/home/me/src" },
    });
    expect(store.getState().error).toBe(listingError);
    expect(await store.getState().createFile("notes.txt")).toMatchObject({
      kind: "alreadyExists", details: { path: "/home/me/notes.txt" },
    });
    expect(store.getState().error).toBe(listingError);
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

    expect(await store.getState().setPermissions("/home/me", "notes.txt", { mode: 0o600, scope: "entry" })).toBeNull();

    expect(api.chmodFile).toHaveBeenCalledWith(7, "/home/me/notes.txt", { mode: 0o600, scope: "entry" });
    expect(api.listFiles).toHaveBeenCalledTimes(2);
  });

  it("keeps permission failures with the dialog and applies edits to the directory it opened in", async () => {
    const error = { kind: "permissionDenied", message: "denied", details: { path: "/home/me/notes.txt" } };
    const { api, store } = await connected({ chmodFile: vi.fn().mockRejectedValue(error) });
    await store.getState().navigate("/home/me/src");
    const change = { gid: 42, scope: "entry" } as const;

    expect(await store.getState().setPermissions("/home/me", "notes.txt", change)).toEqual(error);
    expect(api.chmodFile).toHaveBeenCalledWith(7, "/home/me/notes.txt", change);
    expect(store.getState().path).toBe("/home/me/src");
    expect(store.getState().error).toBeNull();
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
