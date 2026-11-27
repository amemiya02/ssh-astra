import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/dialog";
import { ConnectPromptDialog } from "@/features/connect/ConnectPromptDialog";
import { connectionsStore, useConnections } from "@/features/connect/connectionsStore";
import { usePaletteActions } from "@/features/palette/palette-actions";
import { showToast } from "@/features/toasts/toastStore";
import { readCommandError, refusal, type ConnectPrompt, type PromptAnswer } from "@/lib/ipc/connect";
import { testHostConnection } from "@/lib/ipc/connections";
import { isTemporaryHost, redetectHostOs, type GroupId, type Host, type HostDraft, type HostId, type HostImportSource, type ImportReport, type TemporaryHost } from "@/lib/ipc/hosts";
import { pickOpenPath, pickSavePath } from "@/lib/ipc/system";
import { HostBatchDialogContent, type BatchQuestion } from "./HostBatchDialog";
import { ConfirmRemoveDialogContent, HostFormDialogContent, type Removal } from "./HostDialogs";
import type { HostBatchActions, HostListActions } from "./HostList";
import { HostImportDialogContent } from "./HostImportDialog";
import { ImportReportDialogContent } from "./ImportReportDialog";
import { emptyHostSelection, type HostSelection } from "./host-selection";
import { maxHostTags } from "./host-tags";
import { importReportSummary } from "./importReportSummary";
import { hostsStore, useHosts } from "./hostsStore";

/** Opening a Host's Terminal, SFTP and Port forwards is the workspace's business, not the controller's. */
export interface HostOpeners {
  open(host: Host): void;
  openAll(hosts: readonly Host[]): void;
  openSftp(host: Host): void;
  openForwards(host: Host): void;
}

/**
 * Everything the Host list and Home share: the row actions, the Host editor, the delete and
 * import dialogs, "Connect only" questions, and the last action's error or notice. It lives in
 * `App` (always mounted), so a dialog opened from Home is not lost when the sidebar changes view.
 */
export interface HostsController {
  actions: HostListActions;
  batchActions: HostBatchActions;
  hostSelection: HostSelection;
  selectHosts(selection: HostSelection): void;
  /** New Hosts and Groups go inside the selected Group. */
  selectedGroupId: GroupId | null;
  selectGroup(id: GroupId): void;
  renamingGroupId: string | null;
  newHost(): void;
  openTemporaryHostEditor(host: TemporaryHost): void;
  createGroup(parentId: string | null): Promise<void>;
  /** Opens the source picker for importing Hosts. */
  openImport(): void;
  importHosts(): Promise<void>;
  exportHosts(): Promise<void>;
  /** The last action's error (alert) and notice (status), if any. */
  messages: ReactNode;
  /** Render once, anywhere: the Host editor, the delete confirmation, prompts and the import report. */
  dialogs: ReactNode;
}

export function useHostsController(openers: HostOpeners, onTemporaryHostSaved: (host: Host) => void): HostsController {
  const { t } = useTranslation();
  const tree = useHosts((s) => s.tree);
  const [selection, setSelection] = useState<HostSelection | { groupId: GroupId }>(emptyHostSelection);
  const selectedGroupId = "groupId" in selection ? selection.groupId : null;
  const hostSelection = "groupId" in selection ? emptyHostSelection : selection;
  /** The Host editor: "new", a Host being edited, or closed. */
  const [editing, setEditing] = useState<Host | "new" | null>(null);
  const [removing, setRemoving] = useState<Removal | null>(null);
  const [batch, setBatch] = useState<BatchQuestion | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const held = useConnections((s) => s.held);
  const connecting = useConnections((s) => s.connecting);
  /** A "Connect only" question waiting for the user. */
  const [pending, setPending] = useState<{ prompt: ConnectPrompt; resolve(answer: PromptAnswer): void } | null>(null);
  const pendingRef = useRef(pending);
  const ask = useCallback(
    (prompt: ConnectPrompt) =>
      new Promise<PromptAnswer>((resolve) => {
        const next = { prompt, resolve };
        pendingRef.current = next;
        setPending(next);
      }),
    [],
  );
  const [importDialog, setImportDialog] = useState<"source" | { report: ImportReport; source: HostImportSource["kind"] } | null>(null);
  /** The outcome of the last export. */
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void connectionsStore.getState().watch();
    // Unmounting mid-connect refuses the open question so the backend stops waiting.
    return () => {
      const open = pendingRef.current;
      if (open) open.resolve(refusal(open.prompt));
    };
  }, []);

  const store = hostsStore.getState;

  /** Runs a store change, showing why it failed instead of throwing. */
  const attempt = useCallback(
    async <T,>(
      change: () => Promise<T>,
      failed: "hosts.actionFailed" | "hosts.transfer.exportFailed" = "hosts.actionFailed",
    ): Promise<T | undefined> => {
      setActionError(null);
      setNotice(null);
      try {
        return await change();
      } catch (e) {
        const error = readCommandError(e);
        const message = error.kind === "hostTagLimit"
          ? t("hosts.batch.tagLimit", { host: error.details?.host, maxTags: maxHostTags })
          : error.message;
        setActionError(t(failed, { message }));
        return undefined;
      }
    },
    [t],
  );

  const transfer = useMemo(() => {
    const filters = [{ name: t("hosts.transfer.fileType"), extensions: ["json"] }];
    return {
      async exportHosts(ids?: readonly HostId[]) {
        const exported = await attempt(async () => {
          const title = t(ids ? "hosts.batch.export" : "hosts.transfer.export");
          const path = await pickSavePath({ title, defaultPath: "sshastra-hosts.json", filters });
          if (path) await hostsStore.getState().exportHosts(path, ids);
          return path;
        }, "hosts.transfer.exportFailed");
        if (exported) setNotice(t("hosts.transfer.exported"));
      },
      async importHosts() {
        setActionError(null);
        setNotice(null);
        try {
          const path = await pickOpenPath({ title: t("hosts.transfer.import"), filters });
          if (!path) return;
          const { hostsAdded: hosts, groupsAdded: groups, skippedHosts } = await hostsStore.getState().importHosts(path);
          showToast((translate) => {
            const added = translate("hosts.transfer.imported", { hosts, groups });
            return skippedHosts.length ? added + " " + translate("hosts.transfer.skipped", { names: skippedHosts.join(", ") }) : added;
          });
        } catch (e) {
          const { message } = readCommandError(e);
          showToast((translate) => translate("hosts.transfer.importFailed", { message }), "error");
        }
      },
    };
  }, [t, attempt]);

  const openImport = useCallback(() => {
    setActionError(null);
    setNotice(null);
    setImportDialog("source");
  }, []);

  const importSource = async (source: HostImportSource) => {
    const report = await store().importHostSource(source);
    setImportDialog({ report, source: source.kind });
    showToast((t) => importReportSummary(t, report, source.kind), report.issues.some((issue) => issue.dropped) ? "error" : "status");
  };

  usePaletteActions(
    useMemo(
      () => [
        { id: "hosts.import", title: t("hosts.transfer.import"), run: () => void transfer.importHosts() },
        { id: "hosts.export", title: t("hosts.transfer.export"), run: () => void transfer.exportHosts() },
        {
          id: "hosts.importSource",
          title: t("hosts.import.action"),
          keywords: t("hosts.import.keywords").split(" "),
          run: openImport,
        },
      ],
      [t, transfer, openImport],
    ),
  );

  const selectGroup = (groupId: GroupId) => setSelection({ groupId });
  const selectOneHost = (id: HostId) => setSelection({ anchor: id, ids: [id] });

  const createGroup = async (parentId: string | null) => {
    const group = await attempt(() => store().createGroup(t("hosts.newGroupName"), parentId));
    if (group) {
      selectGroup(group.id);
      setRenamingGroupId(group.id);
    }
  };

  const actions: HostListActions = {
    open: openers.open,
    openSftp: openers.openSftp,
    openForwards: openers.openForwards,
    connectOnly: (host) => {
      setActionError(null);
      connectionsStore
        .getState()
        .connect(host.id, ask)
        .catch((e: unknown) => {
          const error = readCommandError(e);
          if (error.kind !== "cancelled") {
            setActionError(t("hosts.connectFailed", { name: host.name, message: error.message }));
          }
        });
    },
    disconnect: (host) => void attempt(() => connectionsStore.getState().disconnect(host.id)),
    isHeld: (host) => held.includes(host.id) || connecting.includes(host.id),
    edit: (host) => setEditing(host),
    duplicate: async (host) => {
      const copy = await attempt(() => store().duplicateHost(host.id, t("hosts.copyName", { name: host.name })));
      if (copy) {
        selectOneHost(copy.id);
        setEditing(copy);
      }
    },
    remove: setRemoving,
    createGroup: (parentId) => void createGroup(parentId),
    startRename: setRenamingGroupId,
    rename: (id, name) => {
      setRenamingGroupId(null);
      void attempt(() => store().renameGroup(id, name));
    },
    cancelRename: () => setRenamingGroupId(null),
    move: (op) => void attempt(() => store().move(op)),
  };

  const connectSelection = (ids: readonly HostId[]) => {
    const saved = new Map(store().tree.hosts.map((host) => [host.id, host]));
    const targets = ids.map((id) => saved.get(id));
    if (targets.every((host) => host !== undefined)) openers.openAll(targets);
    else setActionError(t("hosts.batch.selectionChanged"));
  };

  const batchActions: HostBatchActions = {
    move: (ids, groupId) => void attempt(() => store().editHosts(ids, { kind: "move", groupId })),
    editTag: (ids, kind) => setBatch({ kind, ids }),
    remove: (ids) => setBatch({ kind: "delete", ids }),
    connect: (ids) => {
      if (ids.length > 5) setBatch({ kind: "connect", ids });
      else connectSelection(ids);
    },
    export: (ids) => void transfer.exportHosts(ids),
  };

  const temporary = editing && editing !== "new" && isTemporaryHost(editing) ? editing : undefined;
  /** Saves the editor; a new Host goes into the selected Group, last. */
  const save = async (draft: HostDraft, id?: HostId) => {
    if (temporary) return store().saveTemporaryHost(temporary.id, draft);
    const host = await store().saveHost(draft, id);
    if (!id && selectedGroupId) {
      const index = store().tree.hosts.filter((h) => h.groupId === selectedGroupId).length;
      await attempt(() => store().move({ kind: "host", id: host.id, parentId: selectedGroupId, index }));
    }
    return host;
  };

  const messages = (actionError || notice) && (
    <>
      {actionError && (
        <p role="alert" className="text-destructive px-1 text-xs">
          {actionError}
        </p>
      )}
      {notice && (
        <p role="status" className="text-muted-foreground px-1 text-xs">
          {notice}
        </p>
      )}
    </>
  );

  const dialogs = (
    <>
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing !== null && (
          <HostFormDialogContent
            host={editing === "new" ? undefined : tree.hosts.find((host) => host.id === editing.id) ?? editing}
            hosts={editing === "new" ? tree.hosts : tree.hosts.filter((h) => h.id !== editing.id)}
            groupName={tree.groups.find((group) => group.id === (editing === "new" ? selectedGroupId : editing.groupId))?.name}
            save={save}
            testConnection={testHostConnection}
            redetectOs={redetectHostOs}
            onCancel={() => setEditing(null)}
            onSaved={(host) => {
              if (temporary) onTemporaryHostSaved(host);
              selectOneHost(host.id);
              setEditing(null);
            }}
          />
        )}
      </Dialog>
      {pending && (
        <ConnectPromptDialog
          prompt={pending.prompt}
          open
          onAnswer={(answer) => {
            pendingRef.current = null;
            setPending(null);
            pending.resolve(answer);
          }}
        />
      )}
      <Dialog open={importDialog !== null} onOpenChange={(open) => !open && setImportDialog(null)}>
        {importDialog === "source" ? (
          <HostImportDialogContent onImport={importSource} onClose={() => setImportDialog(null)} />
        ) : importDialog && (
          <ImportReportDialogContent {...importDialog} onClose={() => setImportDialog(null)} />
        )}
      </Dialog>
      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        {removing && (
          <ConfirmRemoveDialogContent
            removal={removing}
            onCancel={() => setRemoving(null)}
            onConfirm={() => {
              const target = removing;
              setRemoving(null);
              if (target.kind === "host") void attempt(() => store().deleteHost(target.host.id));
              else void attempt(() => store().deleteGroup(target.group.id));
            }}
          />
        )}
      </Dialog>
      <Dialog open={batch !== null} onOpenChange={(open) => !open && setBatch(null)}>
        {batch && (
          <HostBatchDialogContent
            question={batch}
            hosts={tree.hosts}
            onCancel={() => setBatch(null)}
            onConfirm={(tag) => {
              setBatch(null);
              const { kind, ids } = batch;
              if (kind === "connect") connectSelection(ids);
              else if (kind === "delete") void attempt(() => store().editHosts(ids, { kind: "delete" }));
              else void attempt(() => store().editHosts(ids, { kind: "tag", change: kind === "addTag" ? "add" : "remove", tag }));
            }}
          />
        )}
      </Dialog>
    </>
  );

  return {
    actions,
    batchActions,
    hostSelection,
    selectHosts: setSelection,
    selectedGroupId,
    selectGroup,
    renamingGroupId,
    newHost: () => setEditing("new"),
    openTemporaryHostEditor: setEditing,
    createGroup,
    openImport,
    importHosts: transfer.importHosts,
    exportHosts: transfer.exportHosts,
    messages,
    dialogs,
  };
}
