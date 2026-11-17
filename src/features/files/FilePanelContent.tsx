import { Eye, EyeOff, LoaderCircle, RefreshCw, Unplug } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { IconButton } from "@/components/IconButton";
import { Button } from "@/components/ui/button";
import { useFilePanelDock } from "@/features/shell/file-panel-dock";
import type { ConnectionStatus } from "@/features/workspace/tabs";
import type { Host } from "@/lib/ipc/hosts";
import { useSetting } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { FileBrowser } from "./FileBrowser";
import { errorText } from "./fileErrors";
import { followConnection } from "./fileBrowserStore";
import { fileBrowsers } from "./fileBrowsers";
import { filesSetting } from "./file-prefs";
import { FilePanel } from "./FilePanel";
import { RemoteEdits } from "./RemoteEdits";

/** The focused remote Terminal pane, whose Host the File panel browses. */
export interface FilePanelPane {
  id: string;
  host: Host;
  status: ConnectionStatus;
}

/**
 * The File panel slot: the focused remote Terminal's File panel (each pane keeps its own,
 * with its own directory), or the empty state. `remotePaneIds` lists every open remote
 * Terminal pane; File panels of the others are closed.
 */
export function FilePanelContent({ pane, remotePaneIds }: { pane?: FilePanelPane; remotePaneIds: string[] }) {
  const key = remotePaneIds.join("\n");
  useEffect(() => fileBrowsers.retain(new Set(key ? key.split("\n") : [])), [key]);
  if (!pane) return <FilePanel />;
  return <RemoteFilePanel key={pane.id} pane={pane} />;
}

function RemoteFilePanel({ pane }: { pane: FilePanelPane }) {
  const { t } = useTranslation();
  const { collapsed } = useFilePanelDock();
  const store = fileBrowsers.get(pane.id, pane.host.id);
  const phase = useStore(store, (s) => s.phase);
  const path = useStore(store, (s) => s.path);
  const loading = useStore(store, (s) => s.loading);
  const error = useStore(store, (s) => s.error);
  const [prefs, setPrefs] = useSetting(filesSetting);

  // SFTP opens on the Terminal's Connection once it is up and the panel is shown, and closes
  // while it is down (dropped, reconnecting), reopening on the new Connection after a reconnect.
  useEffect(() => followConnection(store, pane.status, !collapsed), [pane.status, collapsed, store]);

  const ready = phase === "open" && path !== null;
  const actions = (
    <>
      <IconButton
        label={t("files.showHidden")}
        aria-pressed={prefs.showHidden}
        className={cn(prefs.showHidden && "bg-accent text-foreground")}
        onClick={() => setPrefs({ ...prefs, showHidden: !prefs.showHidden })}
      >
        {prefs.showHidden ? <Eye /> : <EyeOff />}
      </IconButton>
      <IconButton label={t("files.refresh")} disabled={!ready} onClick={() => void store.getState().refresh()}>
        <RefreshCw className={cn(loading && "motion-safe:animate-spin")} />
      </IconButton>
    </>
  );

  let body;
  if (pane.status === "disconnected") {
    body = (
      <Notice icon={<Unplug />} text={t("files.disconnected", { host: pane.host.name })} />
    );
  } else if (pane.status === "connecting") {
    body = <Notice icon={<LoaderCircle className="motion-safe:animate-spin" />} text={t("files.connecting")} />;
  } else if (ready) {
    body = <FileBrowser store={store} hostName={pane.host.name} />;
  } else if (phase === "closed" && error) {
    body = (
      <Notice icon={<Unplug />} text={errorText(t, error, pane.host.name)}>
        <Button variant="outline" size="sm" onClick={() => void store.getState().connect()}>
          {t("files.retry")}
        </Button>
      </Notice>
    );
  } else {
    body = <Notice icon={<LoaderCircle className="motion-safe:animate-spin" />} text={t("files.connecting")} />;
  }

  return (
    <FilePanel actions={actions} footer={<RemoteEdits store={store} hostName={pane.host.name} />}>
      {body}
    </FilePanel>
  );
}

function Notice({ icon, text, children }: { icon: React.ReactNode; text: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <span className="text-muted-foreground [&_svg]:size-5" aria-hidden>
        {icon}
      </span>
      <p role="status" className="text-muted-foreground max-w-64 text-balance">
        {text}
      </p>
      {children}
    </div>
  );
}
