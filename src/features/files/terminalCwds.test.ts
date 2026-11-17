import { describe, expect, it, vi } from "vitest";
import type { Listing } from "@/lib/ipc/files";
import type { FilesApi } from "./fileBrowserStore";
import { createFileBrowsers } from "./fileBrowsers";
import { createTerminalCwds } from "./terminalCwds";

const dirs = new Set(["/home/me", "/srv", "/srv/www", "/tmp/my dir/日本"]);

const api: FilesApi = {
  openFiles: () => Promise.resolve(1),
  listFiles: (_id: number, path: string): Promise<Listing> => {
    const resolved = path === "" ? "/home/me" : path;
    return dirs.has(resolved)
      ? Promise.resolve({ path: resolved, entries: [] })
      : Promise.reject({ kind: "notFound", message: resolved });
  },
  closeFiles: () => Promise.resolve(),
  openRemoteEdit: () => Promise.resolve(1),
  retryRemoteEdit: () => Promise.resolve(),
  closeRemoteEdit: () => Promise.resolve(),
  createDir: () => Promise.resolve(),
  renameFile: () => Promise.resolve(),
  countFiles: () => Promise.resolve(0),
  deleteFiles: () => Promise.resolve(),
  chmodFile: () => Promise.resolve(),
};

async function setup() {
  const browsers = createFileBrowsers(api);
  const panel = browsers.get("pane-1", "host-1");
  await panel.getState().connect();
  const askShell = vi.fn(() => Promise.resolve());
  const cwds = createTerminalCwds(browsers, askShell);
  const shown = () => panel.getState().path;
  // Listing is async; let it land.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { panel, cwds, askShell, shown, settle };
}

describe("a File panel following its Terminal's directory", () => {
  it("goes where the shell cd's", async () => {
    const { cwds, shown, settle } = await setup();
    expect(shown()).toBe("/home/me");

    cwds.report("pane-1", "/srv/www");
    await settle();
    expect(shown()).toBe("/srv/www");

    cwds.report("pane-1", "/tmp/my dir/日本");
    await settle();
    expect(shown()).toBe("/tmp/my dir/日本");
  });

  it("stays where the user browsed while the shell's directory does not change", async () => {
    const { panel, cwds, shown, settle } = await setup();
    cwds.report("pane-1", "/srv/www");
    await settle();
    await panel.getState().navigate("/srv");

    // Every prompt reports again; same directory, so the panel stays.
    cwds.report("pane-1", "/srv/www");
    await settle();
    expect(shown()).toBe("/srv");
  });

  it("ignores reports for panes without a File panel", async () => {
    const { cwds } = await setup();
    expect(() => cwds.report("pane-2", "/srv")).not.toThrow();
  });
});

describe("syncing a File panel to its Terminal's directory", () => {
  it("goes back to the reported directory when the shell reports by itself", async () => {
    const { panel, cwds, askShell, shown, settle } = await setup();
    cwds.attach("pane-1", 7);
    cwds.report("pane-1", "/srv/www");
    await settle();
    await panel.getState().navigate("/srv");

    cwds.sync("pane-1");
    await settle();
    expect(shown()).toBe("/srv/www");
    expect(askShell).not.toHaveBeenCalled();
  });

  it("asks a shell that does not report by itself, then follows its answer", async () => {
    const { panel, cwds, askShell, shown, settle } = await setup();
    cwds.attach("pane-1", 7);

    cwds.sync("pane-1");
    expect(askShell).toHaveBeenCalledWith(7);
    cwds.report("pane-1", "/srv");
    await settle();
    expect(shown()).toBe("/srv");

    // Asked again, the same answer still brings the panel back.
    await panel.getState().navigate("/home/me");
    cwds.sync("pane-1");
    expect(askShell).toHaveBeenCalledTimes(2);
    cwds.report("pane-1", "/srv");
    await settle();
    expect(shown()).toBe("/srv");
  });

  it("does nothing without a Terminal to ask", async () => {
    const { cwds, askShell } = await setup();
    cwds.sync("pane-1");
    cwds.attach("pane-1", 7);
    cwds.attach("pane-1", null);
    cwds.sync("pane-1");
    expect(askShell).not.toHaveBeenCalled();
  });
});
