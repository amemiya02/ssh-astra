import { DndContext, PointerSensor, pointerWithin, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { ArrowDownToLine, ArrowUpToLine, Eye, EyeOff, Home, Laptop, LoaderCircle, RefreshCw, Server } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { IconButton } from "@/components/IconButton";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ConnectErrorPanel } from "@/features/connect/ConnectErrorPanel";
import { ConnectPromptDialog } from "@/features/connect/ConnectPromptDialog";
import { TransfersPanel } from "@/features/transfers/TransfersPanel";
import { transfersStore } from "@/features/transfers/transfersStore";
import { useOsFileDrop } from "@/features/transfers/use-os-file-drop";
import { privacyModeSetting, workspaceHostName } from "@/features/workspace/privacy-mode";
import type { ConnectionStatus } from "@/features/workspace/tabs";
import { readCommandError, refusal, type ConnectPrompt, type PromptAnswer } from "@/lib/ipc/connect";
import * as edit from "@/lib/ipc/edit";
import * as files from "@/lib/ipc/files";
import { isTemporaryHost, type Host } from "@/lib/ipc/hosts";
import { useSetting } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { EditQuestionDialog } from "./EditQuestionDialog";
import { FileBrowser, type FileExchange } from "./FileBrowser";
import { createFileBrowserStore } from "./fileBrowserStore";
import type { FileBrowserStore } from "./fileBrowsers";
import { filesSetting } from "./file-prefs";
import { errorText } from "./fileErrors";
import { childPath } from "./fileList";
import { followUploads } from "./followUploads";
import { sharedRemoteEdits } from "./sharedRemoteEdits";
import { RemoteEdits } from "./RemoteEdits";

type Side = FileExchange["side"];

interface PendingPrompt {
  prompt: ConnectPrompt;
  resolve(answer: PromptAnswer): void;
}

const windows = typeof navigator !== "undefined" && /^Win/i.test(navigator.platform);
const nativePath = (path: string) => windows ? path.replaceAll("/", "\\") : path;

export function SftpWorkspace({ id, host, active, showPrompts = active, onStatusChange }: {
  id: string;
  host: Host;
  active: boolean;
  showPrompts?: boolean;
  onStatusChange(id: string, status: ConnectionStatus): void;
}) {
  const { t } = useTranslation();
  const [privacyMode] = useSetting(privacyModeSetting);
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [local] = useState(() => createFileBrowserStore({
    ...files,
    ...edit,
    openFiles: files.openLocalFiles,
    deleteFiles: files.deleteLocalFiles,
  }, "", null, { windows, openPath: (path) => files.openLocalPath(nativePath(path)) }));
  const [{ remote, listenForPrompts }] = useState(() => {
    let listening = false;
    let waiting: PendingPrompt | null = null;
    const ask = (prompt: ConnectPrompt): Promise<PromptAnswer> => {
      if (!listening) return Promise.resolve(refusal(prompt));
      return new Promise((resolve) => {
        waiting = {
          prompt,
          resolve(answer) {
            waiting = null;
            if (listening) setPending(null);
            resolve(answer);
          },
        };
        setPending(waiting);
      });
    };
    return {
      remote: createFileBrowserStore({
        ...files,
        ...edit,
        openFiles: (hostId) => files.connectFiles(hostId, ask),
      }, host.id, host.defaultDirectory, undefined, sharedRemoteEdits),
      listenForPrompts() {
        listening = true;
        return () => {
          listening = false;
          waiting?.resolve(refusal(waiting.prompt));
        };
      },
    };
  });

  useEffect(() => {
    const stopPrompts = listenForPrompts();
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      void local.getState().connect();
      void remote.getState().connect();
    });
    const stopLocal = followUploads(local, transfersStore, "download", windows);
    const stopRemote = followUploads(remote, transfersStore);
    return () => {
      cancelled = true;
      stopPrompts();
      stopLocal();
      stopRemote();
      local.getState().dispose();
      remote.getState().dispose();
    };
  }, [listenForPrompts, local, remote]);

  const remotePhase = useStore(remote, (s) => s.phase);
  const remotePath = useStore(remote, (s) => s.path);
  const remoteError = useStore(remote, (s) => s.error);
  const localPath = useStore(local, (s) => s.path);
  const localPhase = useStore(local, (s) => s.phase);
  const connectionError = remoteError?.kind === "protocol" || remoteError?.kind === "notConnected" || remoteError?.kind === "notOpen";
  const remoteReady = remotePhase === "open" && remotePath !== null && !connectionError;
  const localReady = localPhase === "open" && localPath !== null;
  const status = remoteReady ? "connected"
    : remoteError ? "disconnected" : "connecting";
  useEffect(() => onStatusChange(id, status), [id, status, onStatusChange]);

  const upload = (paths: string[]) => {
    if (!remoteReady) return;
    setTransferError(null);
    void transfersStore.getState().upload(host.id, paths, remotePath).catch((error: unknown) => {
      setTransferError(readCommandError(error).message);
    });
  };
  const download = (paths: string[]) => {
    if (!remoteReady || !localReady) return;
    setTransferError(null);
    void transfersStore.getState().download(host.id, paths, nativePath(localPath)).catch((error: unknown) => {
      setTransferError(readCommandError(error).message);
    });
  };
  const copyLocal = remoteReady && localReady ? (paths: string[]) => upload(paths.map(nativePath)) : undefined;
  const copyRemote = localReady && remoteReady ? download : undefined;

  const remoteDrop = useRef<HTMLDivElement>(null);
  const osDrop = useOsFileDrop(remoteDrop, active && remoteReady, upload);
  const [dragSide, setDragSide] = useState<Side | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const drop = (event: DragEndEvent) => {
    setDragSide(null);
    const source = event.active.data.current;
    if (!source?.paths?.length) return;
    if (source.side === "local" && event.over?.id === "remote") copyLocal?.(source.paths);
    if (source.side === "remote" && event.over?.id === "local") copyRemote?.(source.paths);
  };
  const reconnect = () => {
    remote.getState().disconnect();
    void remote.getState().connect();
  };

  return (
    <div className="bg-surface text-foreground flex h-full min-h-0 flex-col">
      <DndContext sensors={sensors} collisionDetection={pointerWithin}
        onDragStart={({ active }) => setDragSide(active.data.current?.side ?? null)}
        onDragCancel={() => setDragSide(null)} onDragEnd={drop}>
        <div className="min-h-0 flex-1">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel id="local" minSize="32%">
              <WorkspaceColumn store={local} side="local" name={t("sftp.local")} copy={copyLocal} dragSide={dragSide} />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="remote" minSize="32%">
              <div ref={remoteDrop} className="h-full">
                <WorkspaceColumn store={remote} side="remote" name={workspaceHostName(host, t, privacyMode)} copy={copyRemote}
                  dragSide={dragSide} osOver={osDrop.over && remoteReady} reconnect={reconnect}
                  connectionError={connectionError} />
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </DndContext>
      {transferError && <p role="alert" className="text-destructive border-t px-3 py-2 text-xs">{transferError}</p>}
      <TransfersPanel dock="right" />
      {active && <EditQuestionDialog store={remote} onDownload={(path) => {
        if (localReady) download([path]);
        else setTransferError(t("sftp.localUnavailable"));
      }} />}
      {pending && (
        <ConnectPromptDialog prompt={pending.prompt} open={showPrompts} hideCredentialSaving={isTemporaryHost(host)} onAnswer={pending.resolve} />
      )}
    </div>
  );
}

function WorkspaceColumn({ store, side, name, copy, dragSide, osOver, reconnect, connectionError }: {
  store: FileBrowserStore;
  side: Side;
  name: string;
  copy?: (paths: string[]) => void;
  dragSide: Side | null;
  osOver?: boolean;
  reconnect?(): void;
  connectionError?: boolean;
}) {
  const { t } = useTranslation();
  const phase = useStore(store, (s) => s.phase);
  const path = useStore(store, (s) => s.path);
  const error = useStore(store, (s) => s.error);
  const loading = useStore(store, (s) => s.loading);
  const selection = useStore(store, (s) => s.selection);
  const [prefs, setPrefs] = useSetting(filesSetting);
  const local = side === "local";
  const ready = phase === "open" && path !== null && !connectionError;
  const { setNodeRef, isOver } = useDroppable({ id: side, disabled: !copy || dragSide === side });
  const highlight = isOver || osOver;
  const heading = local ? <Laptop /> : <Server />;
  const action = t(local ? "sftp.uploadSelection" : "sftp.downloadSelection");
  const retry = reconnect ?? (() => {
    if (phase === "open") void store.getState().navigate("~");
    else void store.getState().connect();
  });

  let body: ReactNode;
  if (ready) {
    body = <FileBrowser store={store} hostName={name} exchange={{ side, copy }} />;
  } else if (error && (phase !== "opening" || connectionError)) {
    body = (
      <div className="flex flex-col items-center">
        {local ? <p role="alert" className="text-destructive px-3 py-4">{errorText(t, error, name)}</p>
          : <ConnectErrorPanel error={error} />}
        <Button size="sm" variant="outline" onClick={retry}>{t("files.retry")}</Button>
      </div>
    );
  } else {
    body = <p role="status" className="text-muted-foreground flex items-center justify-center gap-2 p-6">
      <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
      {t(local ? "sftp.loadingLocal" : "files.connecting")}
    </p>;
  }

  return (
    <section aria-label={name} className="flex h-full min-w-0 flex-col">
      <header className="bg-muted/40 flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <h2 title={name} className="flex min-w-0 flex-1 items-center gap-2 pl-1 font-semibold [&_svg]:size-4 [&_svg]:shrink-0">
          {heading}<span className="truncate">{name}</span>
        </h2>
        <IconButton label={action} disabled={!copy || selection.size === 0}
          onClick={() => path !== null && copy?.([...selection].map((entry) => childPath(path, entry)))}>
          {local ? <ArrowUpToLine /> : <ArrowDownToLine />}
        </IconButton>
        <IconButton label={t("sftp.home")} disabled={!ready} onClick={() => void store.getState().navigate("~")}>
          <Home />
        </IconButton>
        <IconButton label={t("files.showHidden")} aria-pressed={prefs.showHidden}
          onClick={() => setPrefs({ ...prefs, showHidden: !prefs.showHidden })}>
          {prefs.showHidden ? <Eye /> : <EyeOff />}
        </IconButton>
        <IconButton label={t("files.refresh")} disabled={!ready} onClick={() => void store.getState().refresh()}>
          <RefreshCw className={cn(loading && "motion-safe:animate-spin")} />
        </IconButton>
      </header>
      <div ref={setNodeRef} className="relative min-h-0 flex-1 overflow-auto">
        {body}
        {highlight && (
          <div className="bg-selected ring-ring pointer-events-none absolute inset-1 grid place-items-center rounded-lg ring-2 ring-inset">
            <p className="bg-surface shadow-panel rounded-md px-3 py-1.5 text-xs font-medium">{t("files.dropHere", { path })}</p>
          </div>
        )}
      </div>
      {!local && <RemoteEdits store={store} hostName={name} />}
    </section>
  );
}
