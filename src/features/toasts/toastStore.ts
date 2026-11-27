import type { TFunction } from "i18next";
import { createStore } from "zustand/vanilla";

type ToastMessage = (t: TFunction) => string;
type ToastKind = "status" | "error";
interface Toast {
  id: number;
  message: ToastMessage;
  kind: ToastKind;
}

interface ToastState {
  visible: Toast[];
  show(message: ToastMessage, kind?: ToastKind): number;
  dismiss(id: number): void;
}

const visibleLimit = 3;
const displayDuration = 5_000;

export function createToastStore() {
  const pending: Toast[] = [];
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 0;

  return createStore<ToastState>()((set, get) => {
    function dismiss(id: number) {
      const visible = get().visible.filter((toast) => toast.id !== id);
      if (visible.length === get().visible.length) return;
      clearTimeout(timers.get(id));
      timers.delete(id);
      const next = pending.shift();
      if (next) {
        visible.push(next);
        startTimer(next);
      }
      set({ visible });
    }

    function startTimer(toast: Toast) {
      if (toast.kind === "status") timers.set(toast.id, setTimeout(() => dismiss(toast.id), displayDuration));
    }

    return {
      visible: [],
      show(message, kind = "status") {
        const toast = { id: ++nextId, message, kind };
        const { visible } = get();
        if (visible.length >= visibleLimit) pending.push(toast);
        else {
          startTimer(toast);
          set({ visible: [...visible, toast] });
        }
        return toast.id;
      },
      dismiss,
    };
  });
}

export const toastStore = createToastStore();
export const showToast = toastStore.getState().show;
