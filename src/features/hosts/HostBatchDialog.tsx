import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Host, HostId } from "@/lib/ipc/hosts";
import { appendHostTag, hostTagNames, maxHostTags, maxTagLength } from "./host-tags";

export interface BatchQuestion {
  kind: "addTag" | "removeTag" | "delete" | "connect";
  ids: readonly HostId[];
}

const copy = {
  addTag: { title: "hosts.batch.addTagTitle", body: "hosts.tags.limits", action: "hosts.batch.addTag" },
  removeTag: { title: "hosts.batch.removeTagTitle", body: "hosts.batch.removeTagBody", action: "hosts.batch.removeTag" },
  delete: { title: "hosts.batch.deleteTitle", body: "hosts.batch.deleteBody", action: "hosts.delete" },
  connect: { title: "hosts.batch.connectTitle", body: "hosts.batch.connectBody", action: "hosts.batch.connect" },
} as const;

export function HostBatchDialogContent({ question, hosts, onConfirm, onCancel }: {
  question: BatchQuestion;
  hosts: Host[];
  onConfirm(tag: string): void;
  onCancel(): void;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const [tag, setTag] = useState("");
  const { kind, ids } = question;
  const { title, body, action } = copy[kind];
  const editingTags = kind === "addTag" || kind === "removeTag";
  const selected = new Set(ids);
  const tags = editingTags
    ? hostTagNames(kind === "removeTag" ? hosts.filter((host) => selected.has(host.id)) : hosts)
    : [];
  const normalized = appendHostTag([], tag)[0] ?? "";
  return (
    <DialogContent showCloseButton={false} className="max-w-[calc(100%-2rem)] p-5 sm:max-w-120">
      <form className="grid gap-4" onSubmit={(event) => {
        event.preventDefault();
        if (!editingTags || normalized) onConfirm(normalized);
      }}>
        <DialogHeader>
          <DialogTitle>{t(title, { count: ids.length })}</DialogTitle>
          <DialogDescription>{t(body, { maxTags: maxHostTags, maxLength: maxTagLength })}</DialogDescription>
        </DialogHeader>
        {editingTags && (
          <div className="grid gap-1.5">
            <Label htmlFor={inputId} className="text-xs">{t("hosts.batch.tagLabel")}</Label>
            {kind === "addTag" ? (
              <>
                <Input id={inputId} list={`${inputId}-suggestions`} value={tag} onChange={(event) => setTag(event.target.value)}
                  autoCapitalize="off" autoCorrect="off" spellCheck={false} autoFocus />
                <datalist id={`${inputId}-suggestions`}>
                  {tags.map((name) => <option key={name} value={name} />)}
                </datalist>
              </>
            ) : (
              <Select value={tag} onValueChange={setTag}>
                <SelectTrigger id={inputId} className="w-full" size="sm">
                  <SelectValue placeholder={t("hosts.batch.chooseTag")} />
                </SelectTrigger>
                <SelectContent>
                  {tags.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" autoFocus={!editingTags} onClick={onCancel}>
            {t("hosts.cancel")}
          </Button>
          <Button type="submit" variant={kind === "delete" ? "destructive" : "default"} size="sm" disabled={editingTags && !normalized}>
            {t(action)}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
