import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/dialog";
import { ConnectPromptDialog } from "@/features/connect/ConnectPromptDialog";
import { connectionsStore, useConnections } from "@/features/connect/connectionsStore";
import { usePaletteActions } from "@/features/palette/palette-actions";
import { readCommandError, refusal, type ConnectPrompt, type PromptAnswer } from "@/lib/ipc/connect";
import type { Host, HostDraft, HostId, ImportReport } from "@/lib/ipc/hosts";
import { pickOpenPath, pickSavePath } from "@/lib/ipc/system";
import { ConfirmRemoveDialogContent, HostFormDialogContent, type Removal } from "./HostDialogs";
import type { HostListActions } from "./HostList";
import { ImportReportDialogContent } from "./ImportReportDialog";
import type { DragItem } from "./hostTree";
import { hostsStore, useHosts } from "./hostsStore";

/** Opening a Host's Terminal, SFTP and Port forwards is the workspace's business, not the controller's. */
export interface HostOpeners {
  open(host: Host): void;
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
  /** The selected row of the Host list; a new Host goes into a selected Group. */
  selected: DragItem | null;
  setSelected(item: DragItem | null): void;
  selectedGroupId: string | null;
  renamingGroupId: string | null;
  newHost(): void;
  createGroup(parentId: string | null): Promise<void>;
  /** Imports ~/.ssh/config, then shows the report (or why it failed). */
  importSshConfig(): void;
  importHosts(): Promise<void>;
  exportHosts(): Promise<void>;
  /** The last action's error (alert) and notice (status), if any. */
  messages: ReactNode;
  /** Render once, anywhere: the Host editor, the delete confirmation, prompts and the import report. */
  dialogs: ReactNode;
}

export function useHostsController(openers: HostOpeners): HostsController {
  const { t } = useTranslation();
  const tree = useHosts((s) => s.tree);
  const [selected, setSelected] = useState<DragItem | null>(null);
  /** The Host editor: "new", a Host being edited, or closed. */
  const [editing, setEditing] = useState<Host | "new" | null>(null);
  const [removing, setRemoving] = useState<Removal | null>(null);
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
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  /** The outcome of the last export or import. */
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void hostsStore.getState().load();
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
      failed: "hosts.actionFailed" | "hosts.transfer.exportFailed" | "hosts.transfer.importFailed" = "hosts.actionFailed",
    ): Promise<T | undefined> => {
      setActionError(null);
      setNotice(null);
      try {
        return await change();
      } catch (e) {
        setActionError(t(failed, { message: readCommandError(e).message }));
        return undefined;
      }
    },
    [t],
  );

  const transfer = useMemo(() => {
    const filters = [{ name: t("hosts.transfer.fileType"), extensions: ["json"] }];
    return {
      async exportHosts() {
        const exported = await attempt(async () => {
          const path = await pickSavePath({ title: t("hosts.transfer.export"), defaultPath: "sshastra-hosts.json", filters });
          if (path) await hostsStore.getState().exportHosts(path);
          return path;
        }, "hosts.transfer.exportFailed");
        if (exported) setNotice(t("hosts.transfer.exported"));
      },
      async importHosts() {
        const summary = await attempt(async () => {
          const path = await pickOpenPath({ title: t("hosts.transfer.import"), filters });
          return path ? hostsStore.getState().importHosts(path) : null;
        }, "hosts.transfer.importFailed");
        if (!summary) return;
        const added = t("hosts.transfer.imported", { hosts: summary.hostsAdded, groups: summary.groupsAdded });
        const skipped = summary.skippedHosts.length
          ? " " + t("hosts.transfer.skipped", { names: summary.skippedHosts.join(", ") })
          : "";
        setNotice(added + skipped);
      },
    };
  }, [t, attempt]);

  const importSshConfig = useCallback(() => {
    setActionError(null);
    setNotice(null);
    hostsStore
      .getState()
      .importSshConfig()
      .then(setImportReport, (e: unknown) =>
        setActionError(t("hosts.import.error", { message: readCommandError(e).message })),
      );
  }, [t]);

  usePaletteActions(
    useMemo(
      () => [
        { id: "hosts.import", title: t("hosts.transfer.import"), run: () => void transfer.importHosts() },
        { id: "hosts.export", title: t("hosts.transfer.export"), run: () => void transfer.exportHosts() },
        {
          id: "hosts.importSshConfig",
          title: t("hosts.import.action"),
          keywords: t("hosts.import.keywords").split(" "),
          run: importSshConfig,
        },
      ],
      [t, transfer, importSshConfig],
    ),
  );

  const selectedGroupId = selected?.kind === "group" ? selected.id : null;

  const createGroup = async (parentId: string | null) => {
    const group = await attempt(() => store().createGroup(t("hosts.newGroupName"), parentId));
    if (group) {
      setSelected({ kind: "group", id: group.id });
      setRenamingGroupId(group.id);
    }
  };

  const actions: HostListActions = {
    ...openers,
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
        setSelected({ kind: "host", id: copy.id });
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

  /** Saves the editor; a new Host goes into the selected Group, last. */
  const save = async (draft: HostDraft, id?: HostId) => {
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
            host={editing === "new" ? undefined : editing}
            hosts={editing === "new" ? tree.hosts : tree.hosts.filter((h) => h.id !== editing.id)}
            groupName={tree.groups.find((group) => group.id === (editing === "new" ? selectedGroupId : editing.groupId))?.name}
            save={save}
            onCancel={() => setEditing(null)}
            onSaved={(host) => {
              setSelected({ kind: "host", id: host.id });
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
      <Dialog open={importReport !== null} onOpenChange={(open) => !open && setImportReport(null)}>
        {importReport && <ImportReportDialogContent report={importReport} onClose={() => setImportReport(null)} />}
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
    </>
  );

  return {
    actions,
    selected,
    setSelected,
    selectedGroupId,
    renamingGroupId,
    newHost: () => setEditing("new"),
    createGroup,
    importSshConfig,
    importHosts: transfer.importHosts,
    exportHosts: transfer.exportHosts,
    messages,
    dialogs,
  };
}
