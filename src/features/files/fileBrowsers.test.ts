import { describe, expect, it, vi } from "vitest";
import type { EditEvent } from "@/lib/ipc/edit";
import type { FileEntry } from "@/lib/ipc/files";
import { createFileBrowsers } from "./fileBrowsers";
import type { FilesApi } from "./fileBrowserStore";
import { filesSetting } from "./file-prefs";

const api = (): FilesApi => ({
  openFiles: vi.fn(() => Promise.resolve(1)),
  listFiles: vi.fn(() => Promise.resolve({ path: "/home/me", entries: [] })),
  closeFiles: vi.fn(() => Promise.resolve()),
  openRemoteEdit: vi.fn(() => Promise.resolve(5)),
  retryRemoteEdit: vi.fn(() => Promise.resolve()),
  closeRemoteEdit: vi.fn(() => Promise.resolve()),
  createDir: vi.fn(() => Promise.resolve()),
  compressFiles: vi.fn(() => Promise.resolve()),
  extractArchive: vi.fn(() => Promise.resolve()),
  createEmptyFile: vi.fn(() => Promise.resolve()),
  renameFile: vi.fn(() => Promise.resolve()),
  countFiles: vi.fn(() => Promise.resolve(0)),
  folderSize: vi.fn(() => Promise.resolve(0)),
  searchNames: vi.fn(() => Promise.resolve(null)),
  deleteFiles: vi.fn(() => Promise.resolve()),
  chmodFile: vi.fn(() => Promise.resolve()),
});

const notes: FileEntry = {
  name: "notes.txt", kind: "file", size: 1, modified: null, permissions: null, linkTarget: null,
};
const path = "/home/me/notes.txt";

describe("fileBrowsers", () => {
  it("keeps one File panel per Terminal pane", () => {
    const browsers = createFileBrowsers(api());

    const first = browsers.get("pane-1", "host-1");
    expect(browsers.get("pane-1", "host-1")).toBe(first);
    expect(browsers.get("pane-2", "host-1")).not.toBe(first);
    expect(browsers.find("pane-1")).toBe(first);
    expect(browsers.find("pane-3")).toBeUndefined();
  });

  it("shares saves, retry and final cleanup across two panes editing one Host and path", async () => {
    const fake = api();
    let notify!: (event: EditEvent) => void;
    fake.openRemoteEdit = vi.fn(async (_host, _path, onEvent) => {
      // Rust keeps the first channel when it shows the same edit again.
      notify ??= onEvent;
      return 5;
    });
    const browsers = createFileBrowsers(fake);
    const a = browsers.get("A", "web");
    const b = browsers.get("B", "web");
    await Promise.all([a.getState().connect(), b.getState().connect()]);
    await a.getState().open(notes);
    notify({ state: "uploaded" });
    await b.getState().open(notes);
    expect(b.getState().edits[0]?.status).toBe("uploaded");

    notify({ state: "uploadFailed", reason: "connection dropped" });
    expect(a.getState().edits).toEqual(b.getState().edits);
    await b.getState().retryEdit(path);
    expect(a.getState().edits[0]?.status).toBe("uploading");
    expect(fake.retryRemoteEdit).toHaveBeenCalledWith(5);

    browsers.retain(new Set(["B"]));
    expect(fake.closeRemoteEdit).not.toHaveBeenCalled();
    notify({ state: "uploaded" });
    expect(b.getState().edits[0]?.status).toBe("uploaded");
    expect(a.getState().edits).toEqual([]);
    b.getState().closeEdit(path);
    browsers.retain(new Set());
    expect(fake.closeRemoteEdit).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("shares a pending open and waits for final cleanup before reopening the same path", async () => {
    const fake = api();
    let opened!: (id: number) => void;
    let closed!: () => void;
    const open = vi.fn<FilesApi["openRemoteEdit"]>()
      .mockImplementationOnce(() => new Promise(resolve => { opened = resolve; }))
      .mockResolvedValue(6);
    fake.openRemoteEdit = open;
    fake.closeRemoteEdit = vi.fn(() => new Promise<void>(resolve => { closed = resolve; }));
    const browsers = createFileBrowsers(fake);
    const a = browsers.get("A", "web");
    const b = browsers.get("B", "web");
    await Promise.all([a.getState().connect(), b.getState().connect()]);
    const both = Promise.all([a.getState().open(notes), b.getState().open(notes)]);
    browsers.retain(new Set(["B"]));
    opened(5);
    await both;
    expect(open).toHaveBeenCalledTimes(1);
    expect(b.getState().edits[0]?.id).toBe(5);

    b.getState().closeEdit(path);
    const reopened = b.getState().open(notes);
    expect(open).toHaveBeenCalledTimes(1);
    closed();
    await reopened;
    expect(b.getState().edits[0]?.id).toBe(6);
  });

  it("keeps identically named files on different Hosts independent", async () => {
    const fake = api();
    fake.openRemoteEdit = async (host) => host === "web" ? 5 : 6;
    const browsers = createFileBrowsers(fake);
    const a = browsers.get("A", "web");
    const b = browsers.get("B", "db");
    await Promise.all([a.getState().connect(), b.getState().connect()]);
    await Promise.all([a.getState().open(notes), b.getState().open(notes)]);
    a.getState().closeEdit(path);
    expect(fake.closeRemoteEdit).toHaveBeenCalledExactlyOnceWith(5);
    expect(b.getState().edits[0]?.id).toBe(6);
  });

  it("retires hidden SFTP handles on reconnect and restores the directory when shown", async () => {
    const fake = api();
    const open = vi.fn<FilesApi["openFiles"]>().mockResolvedValueOnce(7).mockResolvedValueOnce(8);
    fake.openFiles = open;
    fake.listFiles = vi.fn(async (_id, path) => ({ path: path || "/home/me", entries: [] }));
    const browsers = createFileBrowsers(fake);
    const a = browsers.get("A", "web");
    const hide = browsers.show("A", "connected");
    await a.getState().connect();
    await a.getState().navigate("/srv");
    hide();
    browsers.connectionChanged("A", "connecting");
    browsers.connectionChanged("A", "connected");
    expect(fake.closeFiles).toHaveBeenCalledExactlyOnceWith(7);
    expect(open).toHaveBeenCalledTimes(1);
    browsers.show("A", "connected");
    await a.getState().connect();
    expect(fake.listFiles).toHaveBeenLastCalledWith(8, "/srv");
  });

  it("closes the File panels of panes that are gone", async () => {
    const fake = api();
    const browsers = createFileBrowsers(fake);
    const gone = browsers.get("pane-1", "host-1");
    await gone.getState().connect();
    browsers.get("pane-2", "host-1");

    browsers.retain(new Set(["pane-2"]));

    expect(fake.closeFiles).toHaveBeenCalledWith(1);
    expect(browsers.find("pane-1")).toBeUndefined();
    expect(browsers.find("pane-2")).toBeDefined();
  });

  it("stops the remote edits of a pane that is gone", async () => {
    const fake = api();
    const browsers = createFileBrowsers(fake);
    const gone = browsers.get("pane-1", "host-1");
    await gone.getState().connect();
    await gone.getState().open({
      name: "notes.txt",
      kind: "file",
      size: 1,
      modified: null,
      permissions: null,
      linkTarget: null,
    });

    browsers.retain(new Set());

    expect(fake.closeRemoteEdit).toHaveBeenCalledWith(5);
  });
});

describe("filesSetting", () => {
  it("repairs a damaged section", () => {
    expect(filesSetting.parse({
      showHidden: "yes", sort: { key: "colour", direction: "up" }, showModified: 0, showPermissions: "no",
      terminalFollowsFilePanel: "on",
    })).toEqual({
      showHidden: false,
      sort: { key: "name", direction: "asc" },
      showModified: true,
      showPermissions: false,
      terminalFollowsFilePanel: false,
    });
    expect(filesSetting.parse(null)).toEqual(filesSetting.defaults);
  });

  it("restores earlier files preferences with the default columns", () => {
    expect(filesSetting.parse({ showHidden: true, sort: { key: "size", direction: "desc" } })).toEqual({
      showHidden: true,
      sort: { key: "size", direction: "desc" },
      showModified: true,
      showPermissions: false,
      terminalFollowsFilePanel: false,
    });
  });
});
