import { Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { IconButton } from "@/components/IconButton";
import { Dialog } from "@/components/ui/dialog";
import { SidebarHeader } from "@/features/shell/SidebarHeader";
import type { Broadcast } from "@/features/workspace/broadcast";
import { readCommandError } from "@/lib/ipc/connect";
import type { Host, HostId } from "@/lib/ipc/hosts";
import { deleteSnippet, listSnippets, saveSnippet, type Snippet } from "@/lib/ipc/snippets";
import { DeleteSnippetDialog, SnippetEditor, SnippetPrompt } from "./SnippetDialogs";
import { parseSnippet } from "./snippet-template";

type InputTarget = NonNullable<ReturnType<Broadcast["captureInput"]>>;
type SnippetDialog =
  | { kind: "edit"; snippet?: Snippet }
  | { kind: "delete"; snippet: Snippet }
  | { kind: "run"; snippet: Snippet; template: ReturnType<typeof parseSnippet>; target: InputTarget };

type Library = { status: "loading" } | { status: "ready"; snippets: Snippet[] } | { status: "error"; message: string };

function visibleOnHost(snippet: Snippet, hostId?: HostId): boolean {
  return snippet.hostIds.length === 0 || (hostId !== undefined && snippet.hostIds.includes(hostId));
}

export function SnippetsSidebar({ broadcast, paneId, hostId, hosts }: {
  broadcast: Broadcast;
  paneId?: string;
  hostId?: HostId;
  hosts: readonly Host[];
}) {
  const { t } = useTranslation();
  const canRun = useStore(broadcast.store, ({ writers }) => paneId !== undefined && writers.has(paneId));
  const [library, setLibrary] = useState<Library>({ status: "loading" });
  const [dialog, setDialog] = useState<SnippetDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void listSnippets().then(
      (snippets) => { if (current) setLibrary({ status: "ready", snippets }); },
      (error: unknown) => { if (current) setLibrary({ status: "error", message: readCommandError(error).message }); },
    );
    return () => { current = false; };
  }, []);

  const groups = new Map<string | null, Snippet[]>();
  if (library.status === "ready") {
    for (const snippet of library.snippets) {
      if (!visibleOnHost(snippet, hostId)) continue;
      const group = groups.get(snippet.group);
      if (group) group.push(snippet);
      else groups.set(snippet.group, [snippet]);
    }
  }

  function openDialog(next: SnippetDialog) {
    setMutationError(null);
    setDialog(next);
  }

  function closeDialog() {
    if (!busy) setDialog(null);
  }

  async function mutate(update: (snippets: Snippet[]) => Promise<Snippet[]>) {
    if (busy || library.status !== "ready") return;
    setBusy(true);
    setMutationError(null);
    try {
      setLibrary({ status: "ready", snippets: await update(library.snippets) });
      setDialog(null);
    } catch (error) {
      setMutationError(t("snippets.saveFailed", { message: readCommandError(error).message }));
    } finally {
      setBusy(false);
    }
  }

  async function send(snippet: Snippet, target: InputTarget, text: string) {
    try {
      if (!visibleOnHost(snippet, hostId) || !(await target.send(text, snippet.sendEnter))) {
        setRunError(t("snippets.terminalUnavailable"));
      }
    } catch (error) {
      setRunError(t("snippets.sendFailed", { message: readCommandError(error).message }));
    }
  }

  function run(snippet: Snippet) {
    setRunError(null);
    const target = paneId ? broadcast.captureInput(paneId) : undefined;
    if (!target) {
      setRunError(t("snippets.terminalUnavailable"));
      return;
    }
    const template = parseSnippet(snippet.command);
    if (template.variables.length > 0) openDialog({ kind: "run", snippet, template, target });
    else {
      const expanded = template.expand(new Map());
      if ("text" in expanded) void send(snippet, target, expanded.text);
    }
  }

  return (
    <section aria-label={t("snippets.title")} className="flex h-full min-h-0 flex-col pr-1 pl-2.5">
      <SidebarHeader title={t("snippets.title")}>
        <IconButton label={t("snippets.new")} disabled={library.status !== "ready"} onClick={() => openDialog({ kind: "edit" })}>
          <Plus />
        </IconButton>
      </SidebarHeader>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2.5">
        {runError && <p role="alert" className="text-destructive px-2 py-1 text-xs">{runError}</p>}
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
                  <IconButton label={t("snippets.runNamed", { name: snippet.name })} disabled={!canRun} onClick={() => run(snippet)}>
                    <Play />
                  </IconButton>
                  <IconButton label={t("snippets.editNamed", { name: snippet.name })} onClick={() => openDialog({ kind: "edit", snippet })}>
                    <Pencil />
                  </IconButton>
                  <IconButton label={t("snippets.deleteNamed", { name: snippet.name })} onClick={() => openDialog({ kind: "delete", snippet })}>
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
        {dialog?.kind === "run" && (
          <SnippetPrompt
            snippet={dialog.snippet}
            template={dialog.template}
            onCancel={closeDialog}
            onRun={(text) => {
              closeDialog();
              void send(dialog.snippet, dialog.target, text);
            }}
          />
        )}
      </Dialog>
    </section>
  );
}
