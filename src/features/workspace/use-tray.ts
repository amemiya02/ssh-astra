import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useEffectEvent, useLayoutEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { recentHostIds, recentHostsSetting } from "@/features/hosts/host-history";
import { hostsStore, useHosts } from "@/features/hosts/hostsStore";
import type { Host, HostId } from "@/lib/ipc/hosts";
import { updateTray } from "@/lib/ipc/windows";
import { useSetting } from "@/lib/storage";

export function useTray(openHost: (host: Host) => void) {
  const { t } = useTranslation();
  const [history] = useSetting(recentHostsSetting);
  const savedHosts = useHosts((state) => state.tree.hosts);
  const openRecent = useEffectEvent((id: HostId) => {
    const host = hostsStore.getState().tree.hosts.find((host) => host.id === id);
    if (host) openHost(host);
  });

  useLayoutEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const subscription = getCurrentWebviewWindow().listen<HostId>("tray-open-host", (event) => {
      if (active) openRecent(event.payload);
    });
    void subscription.catch((error: unknown) => console.warn("Could not listen for tray Host requests", error));
    return () => {
      active = false;
      void subscription.then((unlisten) => unlisten(), () => undefined);
    };
  }, []);

  // The native side resolves the ids against the current saved Hosts and supplies the live count.
  const recent = useMemo(
    () => recentHostIds(history).filter((id) => savedHosts.some((host) => host.id === id)),
    [history, savedHosts],
  );
  useEffect(() => {
    if (!isTauri()) return;
    void updateTray({
      showWindow: t("tray.showWindow"),
      recentHosts: t("tray.recentHosts"),
      runningForwards: t("tray.runningForwards", { running: "{count}" }),
      quit: t("quit.menuQuit"),
    }, recent).catch((error: unknown) => console.warn("Could not update the tray menu", error));
  }, [recent, t]);
}
