import { describe, expect, it, vi } from "vitest";
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
});

describe("fileBrowsers", () => {
  it("keeps one File panel per Terminal pane", () => {
    const browsers = createFileBrowsers(api());

    const first = browsers.get("pane-1", "host-1");
    expect(browsers.get("pane-1", "host-1")).toBe(first);
    expect(browsers.get("pane-2", "host-1")).not.toBe(first);
    expect(browsers.find("pane-1")).toBe(first);
    expect(browsers.find("pane-3")).toBeUndefined();
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
    expect(filesSetting.parse({ showHidden: "yes", sort: { key: "colour", direction: "up" } })).toEqual({
      showHidden: false,
      sort: { key: "name", direction: "asc" },
    });
    expect(filesSetting.parse({ showHidden: true, sort: { key: "size", direction: "desc" } })).toEqual({
      showHidden: true,
      sort: { key: "size", direction: "desc" },
    });
    expect(filesSetting.parse(null)).toEqual(filesSetting.defaults);
  });
});
