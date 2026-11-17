import { describe, expect, it, vi } from "vitest";
import { createFileBrowsers } from "./fileBrowsers";
import type { FilesApi } from "./fileBrowserStore";
import { filesSetting } from "./file-prefs";

const api = (): FilesApi => ({
  openFiles: vi.fn(() => Promise.resolve(1)),
  listFiles: vi.fn(() => Promise.resolve({ path: "/home/me", entries: [] })),
  closeFiles: vi.fn(() => Promise.resolve()),
  createDir: vi.fn(() => Promise.resolve()),
  renameFile: vi.fn(() => Promise.resolve()),
  countFiles: vi.fn(() => Promise.resolve(0)),
  deleteFiles: vi.fn(() => Promise.resolve()),
  chmodFile: vi.fn(() => Promise.resolve()),
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
