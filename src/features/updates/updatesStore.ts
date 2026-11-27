import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import * as ipc from "@/lib/ipc/updates";
import type { AvailableUpdate } from "@/lib/ipc/updates";
import type { UpdateSettings } from "./update-settings";

/** The updater commands the store uses (`@/lib/ipc/updates`); a fake in tests. */
export type UpdatesApi = Pick<typeof ipc, "checkForUpdate" | "relaunchApp">;

/**
 * What the update notice shows. Automatic checks only ever move to `available`: finding nothing
 * or failing leaves `idle`. `upToDate` and `checkFailed` answer a manual check.
 */
export type UpdateStatus =
  | { type: "idle" }
  | { type: "checking" }
  | { type: "upToDate" }
  | { type: "checkFailed"; reason: string }
  | { type: "available"; version: string }
  | { type: "downloading"; version: string; downloaded: number; total?: number }
  | { type: "installFailed"; version: string; reason: string }
  | { type: "restarting"; version: string };

/** Who asked: startup (silent unless there is an update) or the user (always answered). */
export type CheckTrigger = "automatic" | "manual";

export interface UpdatesState {
  status: UpdateStatus;
  /** Asks the update server for a newer version. Never rejects. */
  check(trigger: CheckTrigger): Promise<void>;
  /** Downloads and installs the update found, then restarts into it. Never rejects. */
  install(): Promise<void>;
  /** Hides the notice; a later check offers the update again. */
  dismiss(): void;
}

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

const installing = (status: UpdateStatus) => status.type === "downloading" || status.type === "restarting";

export function createUpdatesStore(api: UpdatesApi): StoreApi<UpdatesState> {
  let found: AvailableUpdate | null = null;
  let running: { manual: boolean; done: Promise<void> } | null = null;

  return createStore<UpdatesState>()((set, get) => ({
    status: { type: "idle" },

    async check(trigger) {
      if (installing(get().status)) return;
      const manual = trigger === "manual";
      if (running) {
        const request = running;
        if (manual && !request.manual) {
          request.manual = true;
          set({ status: { type: "checking" } });
        }
        return request.done;
      }

      // One response publishes once, using the manual result if any caller asked for it.
      const response = new Promise<AvailableUpdate | null>((resolve) => resolve(api.checkForUpdate()));
      const request = { manual, done: finishCheck() };
      running = request;
      if (manual) set({ status: { type: "checking" } });
      return request.done;

      async function finishCheck() {
        let status: UpdateStatus;
        try {
          found = await response;
          if (found) status = { type: "available", version: found.version };
          else status = request.manual ? { type: "upToDate" } : { type: "idle" };
        } catch (error) {
          const reason = errorMessage(error);
          if (!request.manual) status = { type: "idle" };
          else if (reason === ipc.noReleasePublished) status = { type: "upToDate" };
          else status = { type: "checkFailed", reason };
        }
        running = null;
        set({ status });
      }
    },

    async install() {
      const update = found;
      if (!update || installing(get().status)) return;
      const { version } = update;
      set({ status: { type: "downloading", version, downloaded: 0 } });
      try {
        await update.install(({ downloaded, total }) =>
          set({ status: { type: "downloading", version, downloaded, total } }),
        );
      } catch (error) {
        set({ status: { type: "installFailed", version, reason: errorMessage(error) } });
        return;
      }
      set({ status: { type: "restarting", version } });
      try {
        await api.relaunchApp();
      } catch (error) {
        // Installed but not restarted: the new version starts next time.
        set({ status: { type: "installFailed", version, reason: errorMessage(error) } });
      }
    },

    dismiss() {
      if (!installing(get().status)) set({ status: { type: "idle" } });
    },
  }));
}

/** Schedules the silent startup check and returns its cancellation callback. */
export function checkOnStartup(store: StoreApi<UpdatesState>, settings: () => UpdateSettings): () => void {
  const timer = setTimeout(() => {
    if (settings().checkOnStartup) void store.getState().check("automatic");
  }, 5_000);
  return () => clearTimeout(timer);
}

/** The app's updates store, backed by the updater plugin. */
export const updatesStore = createUpdatesStore(ipc);

export function useUpdates<T>(selector: (state: UpdatesState) => T): T {
  return useStore(updatesStore, selector);
}
