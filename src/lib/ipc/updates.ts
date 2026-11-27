import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { recordOperationalEvent } from "./diagnostics";

/** The updater's response when GitHub has no published stable release JSON. */
export const noReleasePublished = "Could not fetch a valid release JSON from the remote";

/** How far an update's download has got. `total` is unknown when the server sends no length. */
export interface DownloadProgress {
  downloaded: number;
  total?: number;
}

/** A newer release found by `checkForUpdate`. */
export interface AvailableUpdate {
  /** The new version, e.g. `0.2.0`. */
  version: string;
  /** Markdown release notes, if provided by the update endpoint. */
  notes?: string;
  /** Downloads it (verifying its signature against the configured public key) and installs it. */
  install(onProgress: (progress: DownloadProgress) => void): Promise<void>;
}

/**
 * Asks the update endpoint (`plugins.updater` in `tauri.conf.json`: the `latest.json` of the
 * latest GitHub release) for a newer version. Resolves `null` when there is none; rejects with
 * the plugin's message when the check fails (offline, no release published yet, ...).
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const update = await check({ timeout: 30_000 }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : error;
    recordOperationalEvent({ kind: "updateCheck", result: message === noReleasePublished ? "noRelease" : "failed" });
    throw error;
  });
  recordOperationalEvent({ kind: "updateCheck", result: update ? "available" : "upToDate" });
  if (!update) return null;
  return {
    version: update.version,
    notes: update.body,
    async install(onProgress) {
      let downloaded = 0;
      let total: number | undefined;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength;
        else if (event.event === "Progress") downloaded += event.data.chunkLength;
        else downloaded = total ?? downloaded;
        onProgress({ downloaded, total });
      });
    },
  };
}

/** Restarts the app, e.g. into the version just installed. */
export function relaunchApp(): Promise<void> {
  return relaunch();
}
