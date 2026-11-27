import { DndContext, PointerSensor, pointerWithin, useDndContext, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { ArrowRightLeft, Download, Eye, EyeOff, FolderSync, LoaderCircle, PanelsTopLeft, RefreshCw, Unplug, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { IconButton } from "@/components/IconButton";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useFilePanelDock } from "@/features/shell/file-panel-dock";
import { privacyModeSetting, workspaceHostName } from "@/features/workspace/privacy-mode";
import type { ConnectionStatus } from "@/features/workspace/tabs";
import { transfersStore } from "@/features/transfers/transfersStore";
import { useOsFileDrop } from "@/features/transfers/use-os-file-drop";
import { readCommandError } from "@/lib/ipc/connect";
import { isTemporaryHost, type Host } from "@/lib/ipc/hosts";
import { pickDownloadFolder, pickFilesToUpload, type TransferHost } from "@/lib/ipc/transfers";
import { useSetting } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { FileBrowser, type FilePanelDropTarget } from "./FileBrowser";
import type { FileMove } from "./fileBrowserStore";
import { childPath } from "./fileList";
import { followUploads } from "./followUploads";
import { EditQuestionDialog } from "./EditQuestionDialog";
import { errorText, operationErrorText } from "./fileErrors";
import { fileBrowsers } from "./fileBrowsers";
import { filesSetting } from "./file-prefs";
import { FilePanel } from "./FilePanel";
import { RemoteEdits } from "./RemoteEdits";
import { terminalCwds } from "./terminalCwds";

/** The focused remote Terminal pane, whose Host the File panel browses. */
export interface FilePanelPane {
  id: string;
  host: Host;
  status: ConnectionStatus;
}

interface RemoteSelection {
  host: TransferHost;
  paths: string[];
}

// The clipboard remains available when switching tabs or hiding the dock.
const fileClipboard = createStore<RemoteSelection | null>()(() => null);
const transferHost = (host: Host): TransferHost => ({
  id: host.id,
  name: host.name,
  ...(isTemporaryHost(host) && { temporary: true }),
});

const filePanelCollisions: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const folders = hits.filter((hit) => hit.data?.droppableContainer.data.current?.folder !== undefined);
  return folders.length ? folders : hits;
};

/** The dock for the focused remote Terminal, with an optional peer Host's File panel. */
export function FilePanelContent({ pane, peers = [], onOpenSftp }: {
  pane?: FilePanelPane;
  peers?: FilePanelPane[];
  onOpenSftp?(host: Host): void;
}) {
  const { t } = useTranslation();
  const [privacyMode] = useSetting(privacyModeSetting);
  const [peerId, setPeerId] = useState("");
  const [copyError, setCopyError] = useState<string | null>(null);
  const dragged = useRef<{ pane: FilePanelPane; files: FileMove } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  if (!pane) return <FilePanel />;
  const candidatesByHost = new Map<string, FilePanelPane>();
  for (const peer of peers) {
    if (peer.status === "connected" && peer.host.id !== pane.host.id &&
      (!candidatesByHost.has(peer.host.id) || peer.id === peerId)) {
      candidatesByHost.set(peer.host.id, peer);
    }
  }
  const candidates = [...candidatesByHost.values()];
  const peer = candidates.find((candidate) => candidate.id === peerId);
  const findPanel = (id: string | undefined) => id === pane.id ? pane : id === peer?.id ? peer : undefined;
  const copy = (selection: RemoteSelection, target: FilePanelPane, directory: string) => {
    setCopyError(null);
    void transfersStore.getState().copyRemote(selection.host, selection.paths, transferHost(target.host), directory)
      .catch((error: unknown) => setCopyError(operationErrorText(t, readCommandError(error))));
  };
  const startDrag = ({ active }: DragStartEvent) => {
    const source = findPanel(active.data.current?.paneId as string | undefined);
    const files = active.data.current?.move as FileMove | undefined;
    // The virtual list can unmount the source row during a drag.
    dragged.current = source && files ? { pane: source, files } : null;
  };
  const drop = ({ over }: DragEndEvent) => {
    const source = dragged.current;
    dragged.current = null;
    const destination = over?.data.current as FilePanelDropTarget | undefined;
    const target = findPanel(destination?.paneId);
    if (!source || !destination || !target || target.status !== "connected") return;
    const store = fileBrowsers.find(target.id);
    const state = store?.getState();
    if (state?.phase !== "open" || state.path === null || state.path !== destination.directory) return;
    const { folder } = destination;
    if (source.pane.id === target.id) {
      if (folder !== undefined) void state.dropIntoFolder(source.files, folder);
      return;
    }
    copy({
      host: transferHost(source.pane.host),
      paths: source.files.names.map((name) => childPath(source.files.directory, name)),
    }, target, folder === undefined ? state.path : childPath(state.path, folder));
  };
  const peerPicker = candidates.length > 0 && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={t("files.peer.choose")} className={cn(peer && "bg-accent text-foreground")}>
          <PanelsTopLeft />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={peer?.id ?? ""} onValueChange={setPeerId}>
          <DropdownMenuRadioItem value="">{t("files.peer.currentOnly")}</DropdownMenuRadioItem>
          {candidates.map((candidate) => (
            <DropdownMenuRadioItem key={candidate.id} value={candidate.id}>{workspaceHostName(candidate.host, t, privacyMode)}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <DndContext sensors={sensors} collisionDetection={filePanelCollisions}
      onDragStart={startDrag} onDragCancel={() => { dragged.current = null; }} onDragEnd={drop}>
      <RemoteFilePanel key={pane.id} pane={pane} onOpenSftp={onOpenSftp} onCopy={copy}
        extraActions={peerPicker} copyError={copyError}
        peer={peer && <RemoteFilePanel key={peer.id} pane={peer} onCopy={copy} embedded />} />
    </DndContext>
  );
}

function RemoteFilePanel({ pane, onOpenSftp, onCopy, embedded, extraActions, peer, copyError }: {
  pane: FilePanelPane;
  onOpenSftp?(host: Host): void;
  onCopy(selection: RemoteSelection, target: FilePanelPane, directory: string): void;
  embedded?: boolean;
  extraActions?: ReactNode;
  peer?: ReactNode;
  copyError?: string | null;
}) {
  const { t } = useTranslation();
  const [privacyMode] = useSetting(privacyModeSetting);
  const hostName = workspaceHostName(pane.host, t, privacyMode);
  const { collapsed, dock } = useFilePanelDock();
  const store = fileBrowsers.get(pane.id, pane.host.id, pane.host.defaultDirectory);
  const phase = useStore(store, (s) => s.phase);
  const path = useStore(store, (s) => s.path);
  const loading = useStore(store, (s) => s.loading);
  const error = useStore(store, (s) => s.error);
  const [prefs, setPrefs] = useSetting(filesSetting);
  const clipboard = useStore(fileClipboard);

  useEffect(() => {
    if (!collapsed) return fileBrowsers.show(pane.id, pane.status);
  }, [pane.id, pane.status, collapsed]);
  useEffect(() => followUploads(store, transfersStore), [store]);

  const ready = pane.status === "connected" && phase === "open" && path !== null;
  const hasSelection = useStore(store, (s) => s.selection.size > 0);

  const upload = (paths: string[]) => {
    if (path !== null) void transfersStore.getState().upload(pane.host.id, paths, path);
  };
  const pickAndUpload = async () => {
    if (path === null) return;
    const paths = await pickFilesToUpload(t("files.uploadTitle", { path }));
    if (paths) upload(paths);
  };
  /** Downloads `names` in the current folder (default: the selection) to a folder the user picks. */
  const download = async (names?: string[]) => {
    const { path: dir, selection } = store.getState();
    const chosen = names ?? [...selection];
    if (dir === null || chosen.length === 0) return;
    downloadPaths(chosen.map((name) => childPath(dir, name)));
  };
  /** Downloads remote `paths` (absolute) to a folder the user picks. */
  const downloadPaths = async (paths: string[]) => {
    const target = await pickDownloadFolder(t("files.downloadTitle"));
    if (target !== null) void transfersStore.getState().download(pane.host.id, paths, target);
  };
  const dropZone = useRef<HTMLDivElement>(null);
  const { over } = useOsFileDrop(dropZone, ready && !collapsed, upload);
  const { active } = useDndContext();
  const { setNodeRef, isOver } = useDroppable({
    id: `file-panel:${pane.id}`,
    disabled: !ready || collapsed,
    data: { directory: path ?? undefined, paneId: pane.id } satisfies FilePanelDropTarget,
  });
  const setDropZone = useCallback((node: HTMLDivElement | null) => {
    dropZone.current = node;
    setNodeRef(node);
  }, [setNodeRef]);
  const crossHostOver = isOver && active?.data.current?.paneId !== pane.id;
  const paste = clipboard && clipboard.host.id !== pane.host.id ? () => {
    const current = store.getState();
    if (current.phase === "open" && current.path !== null) onCopy(clipboard, pane, current.path);
  } : undefined;

  const actions = (
    <>
      {onOpenSftp && (
        <IconButton label={t("sftp.open")} onClick={() => onOpenSftp(pane.host)}>
          <ArrowRightLeft />
        </IconButton>
      )}
      <IconButton label={t("files.upload")} disabled={!ready} onClick={() => void pickAndUpload()}>
        <Upload />
      </IconButton>
      <IconButton label={t("files.download")} disabled={!ready || !hasSelection} onClick={() => void download()}>
        <Download />
      </IconButton>
      <IconButton
        label={t("files.showHidden")}
        aria-pressed={prefs.showHidden}
        className={cn(prefs.showHidden && "bg-accent text-foreground")}
        onClick={() => setPrefs({ ...prefs, showHidden: !prefs.showHidden })}
      >
        {prefs.showHidden ? <Eye /> : <EyeOff />}
      </IconButton>
      <IconButton label={t("files.syncToTerminal")} disabled={!ready} onClick={() => terminalCwds.sync(pane.id)}>
        <FolderSync />
      </IconButton>
      <IconButton label={t("files.refresh")} disabled={!ready} onClick={() => void store.getState().refresh()}>
        <RefreshCw className={cn(loading && "motion-safe:animate-spin")} />
      </IconButton>
    </>
  );

  let body;
  if (pane.status === "disconnected") {
    body = (
      <Notice icon={<Unplug />} text={t("files.disconnected", { host: hostName })} />
    );
  } else if (pane.status === "connecting") {
    body = <Notice icon={<LoaderCircle className="motion-safe:animate-spin" />} text={t("files.connecting")} />;
  } else if (ready) {
    body = (
      <div ref={setDropZone} className="relative h-full">
        <FileBrowser store={store} hostName={hostName} onDownload={(names) => void download(names)} enableMove
          remoteClipboard={{
            paneId: pane.id,
            copy: (paths) => fileClipboard.setState({ host: transferHost(pane.host), paths }, true),
            onCut: () => fileClipboard.setState(null, true),
            paste,
          }} />
        {(over || crossHostOver) && (
          <div className="bg-selected ring-ring pointer-events-none absolute inset-1 flex items-center justify-center rounded-lg ring-2 ring-inset">
            <p className="bg-surface shadow-panel rounded-md px-3 py-1.5 text-xs font-medium">
              {t("files.dropHere", { path })}
            </p>
          </div>
        )}
      </div>
    );
  } else if (phase === "closed" && error) {
    body = (
      <Notice icon={<Unplug />} text={errorText(t, error, hostName)}>
        <Button variant="outline" size="sm" onClick={() => void store.getState().connect()}>
          {t("files.retry")}
        </Button>
      </Notice>
    );
  } else {
    body = <Notice icon={<LoaderCircle className="motion-safe:animate-spin" />} text={t("files.connecting")} />;
  }

  const edits = <RemoteEdits store={store} hostName={hostName} />;
  const editQuestion = <EditQuestionDialog store={store} onDownload={(path) => void downloadPaths([path])} />;
  if (embedded) {
    return (
      <section aria-label={hostName} className="bg-surface flex min-h-0 min-w-0 flex-col">
        <header className="flex h-9 shrink-0 items-center gap-0.5 border-b pr-2 pl-3">
          <h3 className="flex-1 truncate text-xs font-semibold" title={hostName}>{hostName}</h3>
          {actions}
        </header>
        <div className="min-h-0 flex-1">{body}</div>
        {edits}
        {editQuestion}
      </section>
    );
  }
  return (
    <FilePanel actions={<>{extraActions}{actions}</>} footer={<>
      {copyError && <p role="alert" className="text-destructive border-t px-3 py-2 text-xs">{copyError}</p>}
      {edits}
    </>}>
      <div className={cn("grid h-full min-h-0 min-w-0", peer && "bg-border gap-px",
        peer && (dock === "right" ? "grid-rows-2" : "grid-cols-2"))}>
        <section aria-label={hostName} className="bg-surface flex min-h-0 min-w-0 flex-col">
          {peer && <h3 className="flex h-9 shrink-0 items-center truncate border-b px-3 text-xs font-semibold"
            title={hostName}>{hostName}</h3>}
          <div className="min-h-0 flex-1">{body}</div>
        </section>
        {peer}
      </div>
      {editQuestion}
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
