import { createContext } from "react";
import { createStore } from "zustand/vanilla";
import { createBellSound } from "@/features/terminal/bell-sound";
import { terminalSetting } from "@/features/terminal/terminal-prefs";
import { getSetting, watchSetting } from "@/lib/storage";

const flashDuration = 600;

/** A window's transient Terminal indicators, keyed by tab so all its splits share them. */
export function createTabActivity() {
  const store = createStore(() => ({ unread: new Set<string>(), flashing: new Set<string>() }));
  const flashTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const sound = createBellSound();
  let activeId: string | null = null;
  let openTabs = new Set<string>();

  function endFlash(tabId: string) {
    clearTimeout(flashTimers.get(tabId));
    flashTimers.delete(tabId);
    const flashing = new Set(store.getState().flashing);
    flashing.delete(tabId);
    store.setState({ flashing });
  }

  function clearFlashes() {
    if (!flashTimers.size) return;
    for (const timer of flashTimers.values()) clearTimeout(timer);
    flashTimers.clear();
    store.setState({ flashing: new Set() });
  }

  function prepareSound(event: Event) {
    if (event.isTrusted && getSetting(terminalSetting).bell === "sound") sound.prepare();
  }

  return {
    store,
    prepareSound,
    listen() {
      let mode = getSetting(terminalSetting).bell;
      const unwatch = watchSetting(terminalSetting, ({ bell }) => {
        if (bell === mode) return;
        if (mode === "flash") clearFlashes();
        if (mode === "sound") sound.close();
        mode = bell;
        // Settings changes run synchronously inside the gesture that selects the option.
        if (bell === "sound") sound.prepare();
      });
      window.addEventListener("click", prepareSound, true);
      return () => {
        unwatch();
        window.removeEventListener("click", prepareSound, true);
        clearFlashes();
        sound.close();
      };
    },
    updateWorkspace(nextActiveId: string | null, tabIds: string[]) {
      activeId = nextActiveId;
      openTabs = new Set(tabIds);
      const { unread } = store.getState();
      const remaining = new Set([...unread].filter((id) => id !== activeId && openTabs.has(id)));
      if (remaining.size !== unread.size) store.setState({ unread: remaining });
      for (const id of flashTimers.keys()) {
        if (!openTabs.has(id)) endFlash(id);
      }
    },
    output(tabId: string) {
      if (tabId === activeId || !openTabs.has(tabId)) return;
      const { unread } = store.getState();
      if (!unread.has(tabId)) store.setState({ unread: new Set([...unread, tabId]) });
    },
    bell(tabId: string) {
      if (!openTabs.has(tabId)) return;
      const { bell } = getSetting(terminalSetting);
      if (bell === "sound") {
        sound.play();
      } else if (bell === "flash" && !flashTimers.has(tabId)) {
        flashTimers.set(tabId, setTimeout(() => endFlash(tabId), flashDuration));
        store.setState({ flashing: new Set([...store.getState().flashing, tabId]) });
      }
    },
  };
}

export type TabActivity = ReturnType<typeof createTabActivity>;

export const TabActivityContext = createContext<{ activity: TabActivity; tabId: string } | undefined>(undefined);
