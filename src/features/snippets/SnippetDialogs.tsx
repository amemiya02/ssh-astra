import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Host, HostId } from "@/lib/ipc/hosts";
import type { Snippet, SnippetDraft } from "@/lib/ipc/snippets";
import type { parseSnippet } from "./snippet-template";

const newSnippet: SnippetDraft = { name: "", command: "", group: null, hostIds: [], sendEnter: true };
const dialogClass = "max-h-[calc(100dvh-2rem)] overflow-y-auto";

interface MutationDialogProps {
  busy: boolean;
  error: string | null;
  onCancel(): void;
}

export function SnippetEditor({ snippet, hosts, busy, error, onSave, onCancel }: MutationDialogProps & {
  snippet?: Snippet;
  hosts: readonly Host[];
  onSave(draft: SnippetDraft): void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => {
    if (!snippet) return newSnippet;
    const { name, command, group, hostIds, sendEnter } = snippet;
    return { name, command, group, hostIds, sendEnter };
  });
  const syntaxId = useId();
  const knownIds = new Set(hosts.map((host) => host.id));
  const deletedIds = draft.hostIds.filter((id) => !knownIds.has(id));

  function setHost(id: HostId, included: boolean) {
    setDraft({ ...draft, hostIds: included ? [...draft.hostIds, id] : draft.hostIds.filter((hostId) => hostId !== id) });
  }

  return (
    <DialogContent showCloseButton={false} className={dialogClass} aria-describedby={undefined}>
      <DialogHeader>
        <DialogTitle>{t(snippet ? "snippets.edit" : "snippets.new")}</DialogTitle>
      </DialogHeader>
      <form className="grid gap-4" onSubmit={(event) => {
        event.preventDefault();
        if (!busy && draft.name.trim() && draft.command.trim()) onSave(draft);
      }}>
        <label className="grid gap-1.5 font-medium">
          {t("snippets.name")}
          <Input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <label className="grid gap-1.5 font-medium">
          {t("snippets.command")}
          <textarea
            required
            spellCheck={false}
            rows={5}
            aria-describedby={syntaxId}
            className="border-input bg-background focus-visible:ring-ring min-w-0 resize-y rounded-md border px-3 py-2 font-mono text-sm font-normal outline-none focus-visible:ring-1"
            value={draft.command}
            onChange={(event) => setDraft({ ...draft, command: event.target.value })}
          />
        </label>
        <p id={syntaxId} className="text-muted-foreground -mt-2 text-xs">
          {t("snippets.variableSyntax", { variable: "${name}", fallback: "${name:default}", escape: "\\${name}" })}
        </p>
        <label className="grid gap-1.5 font-medium">
          {t("snippets.group")}
          <Input value={draft.group ?? ""} onChange={(event) => setDraft({ ...draft, group: event.target.value })} />
        </label>
        <fieldset className="grid min-w-0 gap-1.5">
          <legend className="mb-1 font-medium">{t("snippets.hostScope")}</legend>
          <p className="text-muted-foreground text-xs">{t("snippets.hostScopeHelp")}</p>
          {(hosts.length > 0 || deletedIds.length > 0) && (
            <div className="border-border grid max-h-28 gap-1 overflow-y-auto rounded-md border p-2">
              {[...hosts.map(({ id, name }) => ({ id, name })), ...deletedIds.map((id) => ({ id, name: t("snippets.removedHost") }))].map(({ id, name }) => (
                <label key={id} className="flex min-w-0 items-center gap-2">
                  <input type="checkbox" className="accent-primary" checked={draft.hostIds.includes(id)} onChange={(event) => setHost(id, event.target.checked)} />
                  <span className="truncate" title={name}>{name}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="accent-primary" checked={draft.sendEnter} onChange={(event) => setDraft({ ...draft, sendEnter: event.target.checked })} />
          {t("snippets.sendEnter")}
        </label>
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>{t("snippets.cancel")}</Button>
          <Button type="submit" disabled={busy || !draft.name.trim() || !draft.command.trim()}>{t("snippets.save")}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export function DeleteSnippetDialog({ snippet, busy, error, onConfirm, onCancel }: MutationDialogProps & {
  snippet: Snippet;
  onConfirm(): void;
}) {
  const { t } = useTranslation();
  return (
    <DialogContent showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>{t("snippets.deleteTitle", { name: snippet.name })}</DialogTitle>
        <DialogDescription>{t("snippets.deleteDescription")}</DialogDescription>
      </DialogHeader>
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>{t("snippets.cancel")}</Button>
        <Button variant="destructive" onClick={onConfirm} disabled={busy}>{t("snippets.delete")}</Button>
      </DialogFooter>
    </DialogContent>
  );
}

export function SnippetPrompt({ snippet, template, onRun, onCancel }: {
  snippet: Snippet;
  template: ReturnType<typeof parseSnippet>;
  onRun(text: string): void;
  onCancel(): void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState(() => new Map(template.variables.map(({ name, defaultValue }) => [name, defaultValue ?? ""])));
  const expanded = template.expand(values);
  return (
    <DialogContent showCloseButton={false} className={dialogClass}>
      <DialogHeader>
        <DialogTitle>{t("snippets.runNamed", { name: snippet.name })}</DialogTitle>
        <DialogDescription>{t("snippets.promptDescription")}</DialogDescription>
      </DialogHeader>
      <form className="grid gap-4" onSubmit={(event) => {
        event.preventDefault();
        if ("text" in expanded) onRun(expanded.text);
      }}>
        {template.variables.map(({ name, defaultValue }) => (
          <label key={name} className="grid gap-1.5 font-medium">
            {name}
            <Input
              required={defaultValue === undefined}
              spellCheck={false}
              className="font-mono"
              value={values.get(name) ?? ""}
              onChange={(event) => setValues(new Map(values).set(name, event.target.value))}
            />
          </label>
        ))}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>{t("snippets.cancel")}</Button>
          <Button type="submit" disabled={"missing" in expanded}>{t("snippets.run")}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
