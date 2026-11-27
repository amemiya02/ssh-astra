import { notifySystem } from "@/features/notifications/system-notifications";
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
  /** Registers an expanded Transfers panel until the returned cleanup is called. */
  trackVisiblePanel(): () => void;
  upload(hostId: HostId, paths: string[], remoteDir: string): Promise<void>;
  download(hostId: HostId, paths: string[], localDir: string): Promise<void>;
  copyRemote(source: TransferHost, paths: string[], target: TransferHost, remoteDir: string): Promise<void>;
  cancel(id: TransferId): Promise<void>;
  pause(id: TransferId): Promise<void>;
  resume(id: TransferId): Promise<void>;
  retry(id: TransferId): Promise<void>;
  answer(id: TransferId, answer: ConflictAnswer): Promise<void>;
  /** Forgets finished transfers among `ids`. */
  dismiss(ids: TransferId[]): Promise<void>;
}

/** How much a new speed sample moves the shown speed (the rest is the earlier speed). */
const smoothing = 0.4;

interface TransferBatchSummary {
  completed: number;
  failed: number;
  cancelled: number;
}

interface TransferBatch {
  remaining: number;
  summary: TransferBatchSummary;
}

export function isFinished(t: Transfer): boolean {
  return t.state.type === "done" || t.state.type === "failed" || t.state.type === "cancelled";
}

/** Transfers pushed by the backend (never polled), with speeds measured here. */
export function createTransfersStore(
  api: TransfersApi,
  now: () => number = () => performance.now(),
  onHiddenFinish?: (transfer: Transfer) => void,
  onBatchFinish?: (summary: TransferBatchSummary) => void,
): StoreApi<TransfersState> {
  /** The latest progress seen of each transfer, to measure its speed. */
  const samples = new Map<TransferId, { at: number; bytes: number }>();
  const visiblePanels = new Set<symbol>();
  return createStore<TransfersState>()((set, get) => {
    const pendingBatches = new Map<TransferId, TransferBatch>();
    const dismissedDuringEnqueue = new Map<TransferId, Transfer>();
    let enqueuing = 0;

    const settleBatchMember = (transfer: Transfer) => {
      const batch = pendingBatches.get(transfer.id);
      if (!batch || !isFinished(transfer)) return;

      pendingBatches.delete(transfer.id);
      const { type } = transfer.state;
      if (type === "done") batch.summary.completed++;
      else if (type === "failed") batch.summary.failed++;
      else batch.summary.cancelled++;
      if (--batch.remaining === 0) onBatchFinish?.(batch.summary);
    };

    const enqueue = async (start: () => Promise<TransferId[]>) => {
      if (!onBatchFinish) {
        await start();
        return;
      }
      enqueuing++;
      try {
        const ids = await start();
        const batch: TransferBatch = { remaining: ids.length, summary: { completed: 0, failed: 0, cancelled: 0 } };
        for (const id of ids) pendingBatches.set(id, batch);
        // A short transfer can settle before the enqueue command returns its IDs.
        for (const transfer of get().transfers) settleBatchMember(transfer);
        for (const id of ids) {
          const dismissed = dismissedDuringEnqueue.get(id);
          if (dismissed) settleBatchMember(dismissed);
        }
      } finally {
        if (--enqueuing === 0) dismissedDuringEnqueue.clear();
      }
    };

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
      settleBatchMember(transfer);
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
          for (const transfer of snapshot) settleBatchMember(transfer);
        },
        apply,
      ),

      trackVisiblePanel() {
        const panel = Symbol();
        visiblePanels.add(panel);
        return () => { visiblePanels.delete(panel); };
      },

      upload(hostId, paths, remoteDir) {
        return enqueue(() => api.uploadFiles(hostId, paths, remoteDir));
      },

      download(hostId, paths, localDir) {
        return enqueue(() => api.downloadFiles(hostId, paths, localDir));
      },

      copyRemote(source, paths, target, remoteDir) {
        return enqueue(() => api.copyRemoteFiles(source, paths, target, remoteDir));
      },

      cancel: (id) => api.cancelTransfer(id),
      pause: (id) => api.pauseTransfer(id),
      resume: (id) => api.resumeTransfer(id),
      retry: (id) => api.retryTransfer(id),
      answer: (id, answer) => api.answerConflict(id, answer),

      async dismiss(ids) {
        const { transfers } = get();
        const finished = new Set<TransferId>();
        for (const transfer of transfers) {
          if (!ids.includes(transfer.id) || !isFinished(transfer)) continue;
          finished.add(transfer.id);
          if (enqueuing > 0) dismissedDuringEnqueue.set(transfer.id, transfer);
        }
        if (!finished.size) return;
        set({ transfers: transfers.filter((t) => !finished.has(t.id)) });
        await api.removeTransfers([...finished]);
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
}, (summary) => {
  notifySystem({ category: "transfers" }, (t) => ({
    title: t("notifications.transfers.title"),
    body: t("notifications.transfers.body", { ...summary }),
  }));
});

export function useTransfers<T>(selector: (state: TransfersState) => T): T {
  return useStore(transfersStore, selector);
}
