import { describe, expect, it, vi } from "vitest";
import type { AvailableUpdate, DownloadProgress } from "@/lib/ipc/updates";
import { checkOnStartup, createUpdatesStore, type UpdatesApi } from "./updatesStore";

function update(version = "0.2.0", install: AvailableUpdate["install"] = vi.fn(() => Promise.resolve())) {
  return { version, install } satisfies AvailableUpdate;
}

function setup(result: () => Promise<AvailableUpdate | null>) {
  const api: UpdatesApi = {
    checkForUpdate: vi.fn(result),
    relaunchApp: vi.fn(() => Promise.resolve()),
  };
  return { api, store: createUpdatesStore(api) };
}

describe("updates store", () => {
  it("offers a newer version found by an automatic check", async () => {
    const { store } = setup(() => Promise.resolve(update("0.2.0")));
    await store.getState().check("automatic");
    expect(store.getState().status).toEqual({ type: "available", version: "0.2.0" });
  });

  it.each([
    ["no newer version", () => Promise.resolve(null)],
    ["no release published (404)", () => Promise.reject("Could not fetch a valid release JSON from the remote")],
    ["offline", () => Promise.reject("error sending request for url (https://github.com/...)")],
  ])("says nothing after an automatic check with %s", async (_, result) => {
    const { store } = setup(result);
    await store.getState().check("automatic");
    expect(store.getState().status).toEqual({ type: "idle" });
  });

  it("reports a manual check that finds nothing newer as up to date", async () => {
    const { store } = setup(() => Promise.resolve(null));
    await store.getState().check("manual");
    expect(store.getState().status).toEqual({ type: "upToDate" });
  });

  it("treats a manual check with no release published yet (404) as up to date", async () => {
    // GitHub's /releases/latest skips pre-releases, so the first release itself has no latest.json.
    const { store } = setup(() => Promise.reject("Could not fetch a valid release JSON from the remote"));
    await store.getState().check("manual");
    expect(store.getState().status).toEqual({ type: "upToDate" });
  });

  it("reports a manual check that fails, with the reason", async () => {
    const { store } = setup(() => Promise.reject(new Error("error sending request")));
    await store.getState().check("manual");
    expect(store.getState().status).toEqual({ type: "checkFailed", reason: "error sending request" });
  });

  it("shows a manual check in progress", async () => {
    let resolve: (value: AvailableUpdate | null) => void = () => {};
    const { store } = setup(() => new Promise((r) => (resolve = r)));
    const done = store.getState().check("manual");
    expect(store.getState().status).toEqual({ type: "checking" });
    resolve(null);
    await done;
  });

  it("asks the server only once while a check is running", async () => {
    let resolve: (value: AvailableUpdate | null) => void = () => {};
    const { api, store } = setup(() => new Promise((r) => (resolve = r)));
    const first = store.getState().check("automatic");
    const second = store.getState().check("manual");
    resolve(update("0.3.0"));
    await Promise.all([first, second]);
    expect(api.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toEqual({ type: "available", version: "0.3.0" });
  });

  it("downloads the update with progress, installs it and restarts", async () => {
    let report: (p: DownloadProgress) => void = () => {};
    let finish: () => void = () => {};
    const install = vi.fn((onProgress: (p: DownloadProgress) => void) => {
      report = onProgress;
      return new Promise<void>((r) => (finish = r));
    });
    const { api, store } = setup(() => Promise.resolve(update("0.2.0", install)));
    await store.getState().check("automatic");

    const done = store.getState().install();
    report({ downloaded: 0, total: 1000 });
    report({ downloaded: 400, total: 1000 });
    expect(store.getState().status).toEqual({ type: "downloading", version: "0.2.0", downloaded: 400, total: 1000 });
    expect(api.relaunchApp).not.toHaveBeenCalled();

    finish();
    await done;
    expect(store.getState().status).toEqual({ type: "restarting", version: "0.2.0" });
    expect(api.relaunchApp).toHaveBeenCalledTimes(1);
  });

  it("keeps the update on offer when installing it fails, with the reason", async () => {
    const install = vi.fn(() => Promise.reject("signature verification failed"));
    const { api, store } = setup(() => Promise.resolve(update("0.2.0", install)));
    await store.getState().check("automatic");

    await store.getState().install();
    expect(store.getState().status).toEqual({
      type: "installFailed",
      version: "0.2.0",
      reason: "signature verification failed",
    });
    expect(api.relaunchApp).not.toHaveBeenCalled();

    await store.getState().install();
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("does nothing on install when no update was found", async () => {
    const { api, store } = setup(() => Promise.resolve(null));
    await store.getState().install();
    expect(store.getState().status).toEqual({ type: "idle" });
    expect(api.relaunchApp).not.toHaveBeenCalled();
  });

  it("leaves a download alone when another check runs", async () => {
    const install = vi.fn(() => new Promise<void>(() => {}));
    const { api, store } = setup(() => Promise.resolve(update("0.2.0", install)));
    await store.getState().check("automatic");
    void store.getState().install();

    await store.getState().check("manual");
    expect(store.getState().status).toMatchObject({ type: "downloading" });
    expect(api.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("hides the notice when dismissed", async () => {
    const { store } = setup(() => Promise.resolve(update()));
    await store.getState().check("automatic");
    store.getState().dismiss();
    expect(store.getState().status).toEqual({ type: "idle" });
  });

  it("checks on startup only when automatic checks are on", async () => {
    const on = setup(() => Promise.resolve(update("0.2.0")));
    await checkOnStartup(on.store, { checkOnStartup: true });
    expect(on.store.getState().status).toEqual({ type: "available", version: "0.2.0" });

    const off = setup(() => Promise.resolve(update("0.2.0")));
    await checkOnStartup(off.store, { checkOnStartup: false });
    expect(off.api.checkForUpdate).not.toHaveBeenCalled();
  });
});
