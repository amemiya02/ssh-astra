import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { HostId } from "@/lib/ipc/hosts";
import * as ipc from "@/lib/ipc/transfers";
import type { ConflictAnswer, Transfer, TransferId } from "@/lib/ipc/transfers";

/** The TransferQueue commands the store uses (`@/lib/ipc/transfers`); a fake in tests. */
export type TransfersApi = Pick<
  typeof ipc,
  | "watchTransfers"
  | "uploadFiles"
  | "downloadFiles"
  | "cancelTransfer"
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
  upload(hostId: HostId, paths: string[], remoteDir: string): Promise<void>;
  download(hostId: HostId, paths: string[], localDir: string): Promise<void>;
  cancel(id: TransferId): Promise<void>;
  retry(id: TransferId): Promise<void>;
  answer(id: TransferId, answer: ConflictAnswer): Promise<void>;
  /** Forgets finished transfers among `ids`. */
  dismiss(ids: TransferId[]): Promise<void>;
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
): StoreApi<TransfersState> {
  /** The latest progress seen of each transfer, to measure its speed. */
  const samples = new Map<TransferId, { at: number; bytes: number }>();
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
    };

    return {
      transfers: [],
      speeds: {},

      async watch() {
        const current = await api.watchTransfers(apply);
        for (const transfer of current) apply(transfer);
      },

      async upload(hostId, paths, remoteDir) {
        await api.uploadFiles(hostId, paths, remoteDir);
      },

      async download(hostId, paths, localDir) {
        await api.downloadFiles(hostId, paths, localDir);
      },

      cancel: (id) => api.cancelTransfer(id),
      retry: (id) => api.retryTransfer(id),
      answer: (id, answer) => api.answerConflict(id, answer),

      async dismiss(ids) {
        const finished = new Set(get().transfers.filter((t) => ids.includes(t.id) && isFinished(t)).map((t) => t.id));
        if (finished.size === 0) return;
        set({ transfers: get().transfers.filter((t) => !finished.has(t.id)) });
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
  const underWay = transfers.filter((t) => !isFinished(t));
  const bytesPerSecond = underWay.reduce((sum, t) => sum + (speeds[t.id] ?? 0), 0);
  return { count: underWay.length, bytesPerSecond };
}

/** The app's transfers store, backed by the Tauri TransferQueue commands. */
export const transfersStore = createTransfersStore(ipc);

export function useTransfers<T>(selector: (state: TransfersState) => T): T {
  return useStore(transfersStore, selector);
}
