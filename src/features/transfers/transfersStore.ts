import { showToast } from "@/features/toasts/toastStore";
import { createSnapshotWatch } from "@/lib/ipc/watchSnapshot";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { HostId } from "@/lib/ipc/hosts";
import * as ipc from "@/lib/ipc/transfers";
import type { ConflictAnswer, Transfer, TransferHost, TransferId } from "@/lib/ipc/transfers";

/** The TransferQueue commands the store uses (`@/lib/ipc/transfers`); a fake in tests. */
export type TransfersApi = Pick<
  typeof ipc,
  | "watchTransfers"
  | "uploadFiles"
  | "downloadFiles"
  | "copyRemoteFiles"
  | "cancelTransfer"
  | "pauseTransfer"
  | "resumeTransfer"
  | "retryTransfer"
  | "answerConflict"
  | "removeTransfers"
>;

export interface TransfersState {
  /** Every transfer, oldest first. */
  transfers: Transfer[];
  /** Bytes per second of each running transfer that has made progress. */
  speeds: Record<TransferId, number>;
  /** Loads the current transfers and follows the backend's changes. Call once. */
  watch(): Promise<void>;
  /** Registers a visible transfer list until the returned cleanup is called. */
  trackVisiblePanel(): () => void;
  upload(host: TransferHost, paths: string[], remoteDir: string): Promise<void>;
  download(host: TransferHost, paths: string[], localDir: string): Promise<void>;
  copyRemote(source: TransferHost, paths: string[], target: TransferHost, remoteDir: string): Promise<void>;
  cancel(id: TransferId): Promise<void>;
  pause(id: TransferId): Promise<void>;
  resume(id: TransferId): Promise<void>;
  retry(id: TransferId): Promise<void>;
  answer(id: TransferId, answer: ConflictAnswer): Promise<void>;
  /** Forgets finished transfers among `ids`. */
  dismiss(ids: TransferId[]): Promise<void>;
  /** Forgets the transfers already completed when this action was requested. */
  clearCompleted(): Promise<void>;
}

/** How much a new speed sample moves the shown speed (the rest is the earlier speed). */
const smoothing = 0.4;

export function isFinished(t: Transfer): boolean {
  return t.state.type === "done" || t.state.type === "failed" || t.state.type === "cancelled";
}

/** Transfers pushed by the backend (never polled), with speeds measured here. */
export function createTransfersStore(
  api: TransfersApi,
  now: () => number = () => performance.now(),
  onHiddenFinish?: (transfer: Transfer) => void,
): StoreApi<TransfersState> {
  /** The latest progress seen of each transfer, to measure its speed. */
  const samples = new Map<TransferId, { at: number; bytes: number }>();
  const visiblePanels = new Set<symbol>();
  return createStore<TransfersState>()((set, get) => {
    const apply = (transfer: Transfer) => {
      const { transfers, speeds } = get();
      const index = transfers.findIndex((t) => t.id === transfer.id);
      const next =
        index === -1
          ? [...transfers, transfer].sort((a, b) => a.id - b.id)
          : transfers.map((t, i) => (i === index ? transfer : t));
      const nextSpeeds = { ...speeds };
      if (transfer.state.type === "running") {
        const at = now();
        const previous = samples.get(transfer.id);
        if (previous && at > previous.at && transfer.bytesDone >= previous.bytes) {
          const sample = ((transfer.bytesDone - previous.bytes) * 1000) / (at - previous.at);
          const before = speeds[transfer.id];
          nextSpeeds[transfer.id] = before === undefined ? sample : before + (sample - before) * smoothing;
        }
        samples.set(transfer.id, { at, bytes: transfer.bytesDone });
      } else {
        samples.delete(transfer.id);
        delete nextSpeeds[transfer.id];
      }
      set({ transfers: next, speeds: nextSpeeds });
      const { type } = transfer.state;
      if (!visiblePanels.size && (type === "done" || type === "failed") && transfers[index]?.state.type !== type) {
        onHiddenFinish?.(transfer);
      }
    };

    return {
      transfers: [],
      speeds: {},

      watch: createSnapshotWatch(
        api.watchTransfers,
        (snapshot) => {
          samples.clear();
          const at = now();
          for (const t of snapshot) {
            if (t.state.type === "running") samples.set(t.id, { at, bytes: t.bytesDone });
          }
          set({ transfers: [...snapshot].sort((a, b) => a.id - b.id), speeds: {} });
        },
        apply,
      ),

      trackVisiblePanel() {
        const panel = Symbol();
        visiblePanels.add(panel);
        return () => { visiblePanels.delete(panel); };
      },

      async upload(host, paths, remoteDir) {
        await api.uploadFiles(host, paths, remoteDir);
      },

      async download(host, paths, localDir) {
        await api.downloadFiles(host, paths, localDir);
      },

      async copyRemote(source, paths, target, remoteDir) {
        await api.copyRemoteFiles(source, paths, target, remoteDir);
      },

      cancel: (id) => api.cancelTransfer(id),
      pause: (id) => api.pauseTransfer(id),
      resume: (id) => api.resumeTransfer(id),
      retry: (id) => api.retryTransfer(id),
      answer: (id, answer) => api.answerConflict(id, answer),

      async dismiss(ids) {
        const finished = new Set(get().transfers.filter((t) => ids.includes(t.id) && isFinished(t)).map((t) => t.id));
        if (finished.size === 0) return;
        set({ transfers: get().transfers.filter((t) => !finished.has(t.id)) });
        await api.removeTransfers([...finished]);
      },

      async clearCompleted() {
        const completed = new Set(doneTransfers(get().transfers).map(({ id }) => id));
        if (completed.size === 0) return;
        await api.removeTransfers([...completed]);
        set(({ transfers }) => ({ transfers: transfers.filter(({ id }) => !completed.has(id)) }));
      },
    };
  });
}

/** The transfer panel's Active list: everything not done, failed ones included (to retry). */
export function activeTransfers(transfers: readonly Transfer[]): Transfer[] {
  return transfers.filter((t) => t.state.type !== "done");
}

export function doneTransfers(transfers: readonly Transfer[]): Transfer[] {
  return transfers.filter((t) => t.state.type === "done");
}

export type TransferFilter = "all" | "inProgress" | "failed" | "completed";

/** Groups each matching row once, under the source Host or the upload's target Host. */
export function transferGroups(transfers: readonly Transfer[], filter: TransferFilter) {
  const groups = new Map<HostId | undefined, { host: TransferHost | undefined; transfers: Transfer[] }>();
  for (const transfer of transfers) {
    if (filter === "inProgress" && isFinished(transfer)) continue;
    if (filter === "failed" && transfer.state.type !== "failed") continue;
    if (filter === "completed" && transfer.state.type !== "done") continue;

    const host = transfer.sourceHost ?? transfer.targetHost;
    let group = groups.get(host?.id);
    if (!group) {
      group = { host, transfers: [] };
      groups.set(host?.id, group);
    }
    group.transfers.push(transfer);
  }
  return [...groups.values()];
}

/** The question to ask now: the oldest transfer waiting on a conflict. */
export function firstConflict(transfers: readonly Transfer[]): Transfer | undefined {
  return transfers.find((t) => t.state.type === "conflict");
}

/** Seconds until `t` is done at `speed` bytes per second; `null` when there is no speed yet. */
export function timeLeft(t: Transfer, speed: number | undefined): number | null {
  if (!speed || speed <= 0) return null;
  return Math.max(0, Math.ceil((t.bytesTotal - t.bytesDone) / speed));
}

/** `42 s`, `3 min`, `1 h 5 min`. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** For the status bar: how many transfers are under way (queued, running or asking) and how fast. */
export function transferSummary(
  transfers: readonly Transfer[],
  speeds: Record<TransferId, number>,
): { count: number; bytesPerSecond: number } {
  const underWay = transfers.filter((t) => !isFinished(t) && t.state.type !== "paused");
  const bytesPerSecond = underWay.reduce((sum, t) => sum + (speeds[t.id] ?? 0), 0);
  return { count: underWay.length, bytesPerSecond };
}

/** The app's transfers store, backed by the Tauri TransferQueue commands. */
export const transfersStore = createTransfersStore(ipc, undefined, ({ name, state }) => {
  if (state.type === "done") showToast((t) => t("toast.transferDone", { name }));
  if (state.type === "failed") showToast((t) => t("toast.transferFailed", { name, reason: state.message }), "error");
});

export function clearCompletedTransfers(): void {
  void transfersStore.getState().clearCompleted().catch(() =>
    showToast((t) => t("transfers.clearFailed"), "error"));
}

export function useTransfers<T>(selector: (state: TransfersState) => T): T {
  return useStore(transfersStore, selector);
}
