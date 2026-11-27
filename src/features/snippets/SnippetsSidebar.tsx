import { Download, Pencil, Play, Plus, Trash2, Upload } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { IconButton } from "@/components/IconButton";
import { Dialog } from "@/components/ui/dialog";
import { usePaletteActions, type PaletteAction } from "@/features/palette/palette-actions";
import { SidebarHeader } from "@/features/shell/SidebarHeader";
import { showToast } from "@/features/toasts/toastStore";
import type { Broadcast } from "@/features/workspace/broadcast";
import { readCommandError } from "@/lib/ipc/connect";
import type { Host, HostId } from "@/lib/ipc/hosts";
import { deleteSnippet, exportSnippets, importSnippets, saveSnippet, type Snippet, type SnippetImportReport } from "@/lib/ipc/snippets";
import { pickOpenPath, pickSavePath } from "@/lib/ipc/system";
import { DeleteSnippetDialog, SnippetEditor, SnippetImportDialog } from "./SnippetDialogs";
import { useSnippetLibrary, visibleOnHost } from "./snippet-library";
import { useSnippetRunner } from "./use-snippet-runner";

type SnippetDialog =
  | { kind: "edit"; snippet?: Snippet }
  | { kind: "delete"; snippet: Snippet }
  | { kind: "importReport"; report: SnippetImportReport };

function reportRunError(message: string | null) {
  if (message) showToast(() => message, "error");
}

export function SnippetsSidebar({ broadcast, paneId, hostId, hosts }: {
  broadcast: Broadcast;
  paneId?: string;
  hostId?: HostId;
  hosts: readonly Host[];
}) {
  const { t } = useTranslation();
  const canRun = useStore(broadcast.store, ({ writers }) => paneId !== undefined && writers.has(paneId));
  const [library, setLibrary] = useSnippetLibrary();
  const [dialog, setDialog] = useState<SnippetDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const operationPending = useRef(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const { run, dialog: runDialog } = useSnippetRunner({ broadcast, hostId, paneId, reportError: reportRunError });
  const visibleSnippets = useMemo(() => library.status === "ready"
    ? library.snippets.filter((snippet) => visibleOnHost(snippet, hostId))
    : [], [hostId, library]);
  const ready = library.status === "ready" && !busy;
  const canExport = ready && library.snippets.length > 0;

  const groups = new Map<string | null, Snippet[]>();
  for (const snippet of visibleSnippets) {
    const group = groups.get(snippet.group);
    if (group) group.push(snippet);
    else groups.set(snippet.group, [snippet]);
  }

  const openDialog = useCallback((next: SnippetDialog) => {
    setMutationError(null);
    setDialog(next);
  }, []);

  function closeDialog() {
    if (!busy) setDialog(null);
  }

  const perform = useCallback(async (operation: () => Promise<void>, onError: (error: unknown) => void) => {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true);
    try {
      await operation();
    } catch (error) {
      onError(error);
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  }, []);

  async function mutate(update: (snippets: Snippet[]) => Promise<Snippet[]>) {
    if (!ready) return;
    await perform(async () => {
      setMutationError(null);
      setLibrary({ status: "ready", snippets: await update(library.snippets) });
      setDialog(null);
    }, (error) => setMutationError(t("snippets.saveFailed", { message: readCommandError(error).message })));
  }

  const transfer = useMemo(() => {
    const filters = [{ name: t("snippets.transfer.fileType"), extensions: ["json"] }];
    return {
      importFile: () => void perform(async () => {
        const path = await pickOpenPath({ title: t("snippets.transfer.import"), filters });
        if (!path) return;
        const report = await importSnippets(path);
        setLibrary((current) => current.status === "ready" && report.added.length
          ? { status: "ready", snippets: [...current.snippets, ...report.added] }
          : current);
        openDialog({ kind: "importReport", report });
      }, (error) => {
        const { message } = readCommandError(error);
        showToast((translate) => translate("snippets.transfer.importFailed", { message }), "error");
      }),
      exportFile: () => void perform(async () => {
        const path = await pickSavePath({ title: t("snippets.transfer.export"), defaultPath: "sshastra-snippets.json", filters });
        if (!path) return;
        await exportSnippets(path);
        showToast((translate) => translate("snippets.transfer.exported"));
      }, (error) => {
        const { message } = readCommandError(error);
        showToast((translate) => translate("snippets.transfer.exportFailed", { message }), "error");
      }),
    };
  }, [openDialog, perform, setLibrary, t]);

  usePaletteActions(useMemo((): PaletteAction[] => {
    if (!ready || dialog) return [];
    return [
      { id: "snippets.import", title: t("snippets.transfer.import"), run: () => transfer.importFile() },
      ...(canExport ? [{ id: "snippets.export", title: t("snippets.transfer.export"), run: () => transfer.exportFile() }] : []),
      ...(canRun ? visibleSnippets.map((snippet) => ({
        id: `snippet.run:${snippet.id}`,
        title: t("snippets.runNamed", { name: snippet.name }),
        keywords: snippet.group ? [t("snippets.title"), snippet.group] : [t("snippets.title")],
        run: () => run(snippet),
      })) : []),
    ];
  }, [canExport, canRun, dialog, ready, run, t, transfer, visibleSnippets]));

  return (
    <section aria-label={t("snippets.title")} className="flex h-full min-h-0 flex-col pr-1 pl-2.5">
      <SidebarHeader title={t("snippets.title")}>
        <IconButton label={t("snippets.transfer.import")} disabled={!ready} onClick={transfer.importFile}>
          <Upload />
        </IconButton>
        <IconButton label={t("snippets.transfer.export")} disabled={!canExport} onClick={transfer.exportFile}>
          <Download />
        </IconButton>
        <IconButton label={t("snippets.new")} disabled={!ready} onClick={() => openDialog({ kind: "edit" })}>
          <Plus />
        </IconButton>
      </SidebarHeader>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2.5">
        {library.status === "loading" && <p role="status" className="text-muted-foreground px-2 py-2">{t("snippets.loading")}</p>}
        {library.status === "error" && (
          <p role="alert" className="text-destructive px-2 py-2">{t("snippets.loadFailed", { message: library.message })}</p>
        )}
        {library.status === "ready" && groups.size === 0 && (
          <p className="text-muted-foreground px-2 py-2">{t(library.snippets.length ? "snippets.emptyHere" : "snippets.empty")}</p>
        )}
        {!canRun && groups.size > 0 && <p className="text-muted-foreground px-2 py-2 text-xs">{t("snippets.focusTerminal")}</p>}
        {[...groups].map(([group, snippets]) => (
          <div key={group ?? ""} className="mb-2">
            {(group !== null || groups.size > 1) && (
              <h3 className="text-muted-foreground truncate px-2 pt-1 pb-0.5 text-xs font-medium" title={group ?? undefined}>
                {group ?? t("snippets.ungrouped")}
              </h3>
            )}
            <ul className="grid gap-0.5">
              {snippets.map((snippet) => (
                <li key={snippet.id} className="hover:bg-accent focus-within:bg-accent flex min-w-0 items-center gap-0.5 rounded-lg py-0.5 pr-0.5 pl-2">
                  <span title={snippet.name} className="min-w-0 flex-1 truncate font-medium">{snippet.name}</span>
                  <IconButton label={t("snippets.runNamed", { name: snippet.name })} disabled={!canRun || busy} onClick={() => run(snippet)}>
                    <Play />
                  </IconButton>
                  <IconButton label={t("snippets.editNamed", { name: snippet.name })} disabled={busy} onClick={() => openDialog({ kind: "edit", snippet })}>
                    <Pencil />
                  </IconButton>
                  <IconButton label={t("snippets.deleteNamed", { name: snippet.name })} disabled={busy} onClick={() => openDialog({ kind: "delete", snippet })}>
                    <Trash2 />
                  </IconButton>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <Dialog open={dialog !== null} onOpenChange={(open) => {
        if (!open) closeDialog();
      }}>
        {dialog?.kind === "edit" && (
          <SnippetEditor
            snippet={dialog.snippet}
            hosts={hosts}
            busy={busy}
            error={mutationError}
            onCancel={closeDialog}
            onSave={(draft) => void mutate(async (snippets) => {
              const saved = await saveSnippet(draft, dialog.snippet?.id);
              return dialog.snippet ? snippets.map((snippet) => snippet.id === saved.id ? saved : snippet) : [...snippets, saved];
            })}
          />
        )}
        {dialog?.kind === "delete" && (
          <DeleteSnippetDialog
            snippet={dialog.snippet}
            busy={busy}
            error={mutationError}
            onCancel={closeDialog}
            onConfirm={() => void mutate(async (snippets) => {
              await deleteSnippet(dialog.snippet.id);
              return snippets.filter((snippet) => snippet.id !== dialog.snippet.id);
            })}
          />
        )}
        {dialog?.kind === "importReport" && <SnippetImportDialog report={dialog.report} onClose={closeDialog} />}
      </Dialog>
      {runDialog}
    </section>
  );
}
