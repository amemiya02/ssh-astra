import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, type CloseRequestedEvent } from "@tauri-apps/api/window";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getSetting } from "@/lib/storage";
import { InterruptionList } from "./InterruptionList";
import type { InterruptionCounts } from "./interruption-counts";
import { workspaceSetting } from "./workspace-prefs";

export function QuitConfirmation({ interruptions }: { interruptions: InterruptionCounts }) {
  const { t } = useTranslation();
  const [connectionsAtQuit, setConnectionsAtQuit] = useState<number | null>(null);
  const checking = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const requestQuit = useEffectEvent(async (event: CloseRequestedEvent) => {
    if (!getSetting(workspaceSetting).confirmQuit) return;
    if (checking.current || connectionsAtQuit !== null) {
      event.preventDefault();
      return;
    }
    checking.current = true;
    try {
      // A transfer can hold a Connection after its last visible Terminal or File panel closes.
      const live = await invoke<number>("quit_live_connection_count").catch((error: unknown) => {
        console.warn("Could not count live Connections before quitting", error);
      });
      const connections = live ?? interruptions.connections;
      if (connections || interruptions.transfers || interruptions.forwards) {
        event.preventDefault();
        setConnectionsAtQuit(connections);
      }
    } finally {
      checking.current = false;
    }
  });

  useLayoutEffect(() => {
    if (!isTauri()) return;
    // Register before the passive effects that can restore remote Connections.
    let active = true;
    const subscription = getCurrentWindow().onCloseRequested((event) => {
      if (active) return requestQuit(event);
      event.preventDefault();
    });
    void subscription.catch((error: unknown) => console.warn("Could not listen for app quit requests", error));
    return () => {
      active = false;
      void subscription.then((unlisten) => unlisten(), () => undefined);
    };
  }, []);

  useEffect(() => {
    if (isTauri()) {
      void invoke("quit_menu_localize", { file: t("quit.menuFile"), quit: t("quit.menuQuit") })
        .catch((error: unknown) => console.warn("Could not translate the quit menu", error));
    }
  }, [t]);

  return (
    <Dialog open={connectionsAtQuit !== null} onOpenChange={(open) => { if (!open) setConnectionsAtQuit(null); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-100" onOpenAutoFocus={(event) => {
        event.preventDefault();
        cancel.current?.focus();
      }}>
        <DialogHeader>
          <DialogTitle>{t("quit.title")}</DialogTitle>
          <DialogDescription asChild>
            <div>
              <p>{t("quit.interruptions")}</p>
              <InterruptionList {...interruptions} connections={connectionsAtQuit ?? 0} />
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancel} variant="outline" onClick={() => setConnectionsAtQuit(null)}>{t("tabs.cancel")}</Button>
          <Button variant="destructive" onClick={() => {
            void getCurrentWindow().destroy().catch((error: unknown) => console.warn("Could not quit SSH Astra", error));
          }}>{t("quit.confirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
