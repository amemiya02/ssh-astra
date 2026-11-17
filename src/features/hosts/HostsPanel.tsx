import { Download, FolderPlus, Plus, Search, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { readCommandError } from "@/lib/ipc/connect";
import { pickOpenPath, pickSavePath } from "@/lib/ipc/system";
import type { Group, Host, HostDraft, HostId } from "@/lib/ipc/hosts";
import { cn } from "@/lib/utils";
import { usePaletteActions } from "@/features/palette/palette-actions";
import { TerminalSchemeSelect } from "@/features/terminal/TerminalSchemeSelect";
import { ClearCredentialsButton } from "./ClearCredentialsButton";
import { HostList, type HostListActions } from "./HostList";
import { HostsSidebar } from "./HostsSidebar";
import { emptyHostForm, hostFormFrom, parseHostForm, type HostFormField, type HostFormResult, type HostFormValues } from "./hostForm";
import { searchTree, type DragItem } from "./hostTree";
import { hostsStore, useHosts } from "./hostsStore";
import { RowMoreMenu } from "./RowMenu";

interface HostsPanelProps {
  /** Open a remote Terminal on the Host. */
  onOpen(host: Host): void;
  /** Opens the Host's Port forwards. */
  onOpenForwards(host: Host): void;
  onOpenLocalTerminal(): void;
}

type Removal = { kind: "host"; host: Host } | { kind: "group"; group: Group };

/**
 * The Host list in the sidebar: search, nested Groups, drag and drop, and the
 * Host editor. Double-click (or Enter on) a Host to open it.
 */
export function HostsPanel({ onOpen, onOpenForwards, onOpenLocalTerminal }: HostsPanelProps) {
  const { t } = useTranslation();
  const tree = useHosts((s) => s.tree);
  const status = useHosts((s) => s.status);
  const loadError = useHosts((s) => s.error);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<DragItem | null>(null);
  /** The Host editor: "new", a Host being edited, or closed. */
  const [editing, setEditing] = useState<Host | "new" | null>(null);
  const [removing, setRemoving] = useState<Removal | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The outcome of the last export or import. */
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void hostsStore.getState().load();
  }, []);

  const searching = query.trim() !== "";
  const nodes = useMemo(() => searchTree(tree, query), [tree, query]);
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

  usePaletteActions(
    useMemo(
      () => [
        { id: "hosts.import", title: t("hosts.transfer.import"), run: () => void transfer.importHosts() },
        { id: "hosts.export", title: t("hosts.transfer.export"), run: () => void transfer.exportHosts() },
      ],
      [t, transfer],
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
    open: onOpen,
    openForwards: onOpenForwards,
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

  let list;
  if (status === "error") {
    list = (
      <div className="flex flex-col gap-2">
        <p role="alert" className="text-destructive px-1 py-2 text-xs">
          {loadError}
        </p>
        {messages}
      </div>
    );
  } else if (tree.hosts.length > 0 || tree.groups.length > 0) {
    list = (
      <div className="flex h-full flex-col gap-2">
        <SearchField value={query} onChange={setQuery} />
        {messages}
        <div className="min-h-0 flex-1">
          {searching && nodes.length === 0 ? (
            <div className="flex flex-col items-start gap-2 px-1 py-4">
              <Search className="text-muted-foreground size-5" aria-hidden />
              <p className="font-medium">{t("hosts.noResultsTitle")}</p>
              <p className="text-muted-foreground text-pretty">{t("hosts.noResultsBody")}</p>
            </div>
          ) : (
            <HostList
              tree={tree}
              nodes={nodes}
              searching={searching}
              selected={selected}
              onSelect={setSelected}
              renamingGroupId={renamingGroupId}
              actions={actions}
            />
          )}
        </div>
      </div>
    );
  } else if (messages) {
    list = <div className="flex flex-col gap-2">{messages}</div>;
  }

  return (
    <>
      <HostsSidebar
        onOpenLocalTerminal={onOpenLocalTerminal}
        actions={
          <>
            <IconButton label={t("hosts.newGroup")} onClick={() => void createGroup(selectedGroupId)}>
              <FolderPlus />
            </IconButton>
            <IconButton label={t("hosts.new")} onClick={() => setEditing("new")}>
              <Plus />
            </IconButton>
            <RowMoreMenu
              label={t("hosts.listActions")}
              align="end"
              entries={[
                {
                  type: "item",
                  label: t("hosts.transfer.import"),
                  icon: <Download />,
                  onSelect: () => void transfer.importHosts(),
                },
                {
                  type: "item",
                  label: t("hosts.transfer.export"),
                  icon: <Upload />,
                  onSelect: () => void transfer.exportHosts(),
                },
              ]}
            />
          </>
        }
      >
        {list}
      </HostsSidebar>
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing !== null && (
          <HostFormDialogContent
            host={editing === "new" ? undefined : editing}
            hosts={editing === "new" ? tree.hosts : tree.hosts.filter((h) => h.id !== editing.id)}
            save={save}
            onCancel={() => setEditing(null)}
            onSaved={(host) => {
              setSelected({ kind: "host", id: host.id });
              setEditing(null);
            }}
          />
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
    </>
  );
}

/** Fuzzy search over names, addresses and users. Escape clears it. */
function SearchField({ value, onChange }: { value: string; onChange(value: string): void }) {
  const { t } = useTranslation();
  return (
    <div className="relative">
      <Search aria-hidden className="text-muted-foreground pointer-events-none absolute top-2 left-2.5 size-3.5" />
      <Input
        type="search"
        aria-label={t("hosts.search")}
        placeholder={t("hosts.search")}
        className="bg-surface h-7.5 pr-8 pl-8 text-sm [&::-webkit-search-cancel-button]:hidden"
        value={value}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            onChange("");
          }
        }}
      />
      {value && (
        <IconButton label={t("hosts.clearSearch")} className="absolute top-0.5 right-0.5" onClick={() => onChange("")}>
          <X />
        </IconButton>
      )}
    </div>
  );
}

/** Confirms deleting a Host or a Group. */
function ConfirmRemoveDialogContent({
  removal,
  onConfirm,
  onCancel,
}: {
  removal: Removal;
  onConfirm(): void;
  onCancel(): void;
}) {
  const { t } = useTranslation();
  const isHost = removal.kind === "host";
  const name = isHost ? removal.host.name : removal.group.name;
  return (
    <DialogContent showCloseButton={false} className="max-w-[calc(100%-2rem)] p-5 sm:max-w-120">
      <DialogHeader>
        <DialogTitle>{isHost ? t("hosts.deleteHostTitle", { name }) : t("hosts.deleteGroupTitle", { name })}</DialogTitle>
        <DialogDescription>{isHost ? t("hosts.deleteHostBody") : t("hosts.deleteGroupBody")}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="outline" size="sm" autoFocus onClick={onCancel}>
          {t("hosts.cancel")}
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={onConfirm}>
          {t("hosts.delete")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

const fields: { field: HostFormField; inputMode?: "numeric" }[] = [
  { field: "name" },
  { field: "address" },
  { field: "port", inputMode: "numeric" },
  { field: "user" },
];

/** Sentinel for "no Jump host": Radix Select reserves the empty string for clearing. */
const NO_JUMP_HOST = "none";

/** The Host editor: a new Host (`host` omitted) or edits to `host`. */
function HostFormDialogContent({
  host,
  hosts,
  save,
  onSaved,
  onCancel,
}: {
  host?: Host;
  /** Hosts that can be picked as the Jump host. */
  hosts: Host[];
  save: (draft: HostDraft, id?: HostId) => Promise<Host>;
  onSaved: (host: Host) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<HostFormValues>(() => (host ? hostFormFrom(host) : emptyHostForm));
  const [errors, setErrors] = useState<Extract<HostFormResult, { ok: false }>["errors"]>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <DialogContent showCloseButton={false} className="max-w-[calc(100%-2rem)] p-5 sm:max-w-120">
      <form
        className="grid gap-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          const result = parseHostForm(values);
          if (!result.ok) {
            setErrors(result.errors);
            return;
          }
          setErrors({});
          setSaving(true);
          save(result.draft, host?.id).then(onSaved, (e: unknown) => {
            setSaveError(readCommandError(e).message);
            setSaving(false);
          });
        }}
      >
        <DialogHeader>
          <DialogTitle>{host ? t("hosts.edit") : t("hosts.new")}</DialogTitle>
          <DialogDescription>{host ? t("hosts.editDescription") : t("hosts.newDescription")}</DialogDescription>
        </DialogHeader>
        {fields.map(({ field, inputMode }) => {
          const id = `host-form-${field}`;
          const error = errors[field];
          return (
            <div key={field} className="grid gap-1.5">
              <Label htmlFor={id} className="text-xs">
                {t(`hosts.fields.${field}`)}
              </Label>
              <Input
                id={id}
                className={cn("h-8", field === "address" && "font-mono")}
                value={values[field]}
                inputMode={inputMode}
                autoFocus={field === "name"}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
                onChange={(event) => setValues((v) => ({ ...v, [field]: event.target.value }))}
              />
              {error && (
                <p id={`${id}-error`} className="text-destructive text-xs">
                  {t(`hosts.errors.${error}`)}
                </p>
              )}
            </div>
          );
        })}
        <div className="grid gap-1.5">
          <Label htmlFor="host-form-auth" className="text-xs">
            {t("hosts.fields.auth")}
          </Label>
          <Select
            value={values.authType}
            onValueChange={(value) => setValues((v) => ({ ...v, authType: value === "key" ? "key" : "password" }))}
          >
            <SelectTrigger id="host-form-auth" size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="password">{t("hosts.auth.password")}</SelectItem>
              <SelectItem value="key">{t("hosts.auth.key")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {values.authType === "key" && (
          <div className="grid gap-1.5">
            <Label htmlFor="host-form-identityFile" className="text-xs">
              {t("hosts.fields.identityFile")}
            </Label>
            <Input
              id="host-form-identityFile"
              className="h-8 font-mono"
              value={values.identityFile}
              placeholder="~/.ssh/id_ed25519"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={errors.identityFile ? true : undefined}
              aria-describedby={errors.identityFile ? "host-form-identityFile-error" : undefined}
              onChange={(event) => setValues((v) => ({ ...v, identityFile: event.target.value }))}
            />
            {errors.identityFile && (
              <p id="host-form-identityFile-error" className="text-destructive text-xs">
                {t(`hosts.errors.${errors.identityFile}`)}
              </p>
            )}
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="host-form-jumpHost" className="text-xs">
            {t("hosts.fields.jumpHost")}
          </Label>
          <Select
            value={values.jumpHost || NO_JUMP_HOST}
            onValueChange={(value) => setValues((v) => ({ ...v, jumpHost: value === NO_JUMP_HOST ? "" : value }))}
          >
            <SelectTrigger id="host-form-jumpHost" size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_JUMP_HOST}>{t("hosts.noJumpHost")}</SelectItem>
              {hosts.map((host) => (
                <SelectItem key={host.id} value={host.id}>
                  {host.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="host-form-terminal-scheme" className="text-xs">
            {t("hosts.fields.terminalScheme")}
          </Label>
          <TerminalSchemeSelect
            id="host-form-terminal-scheme"
            aria-describedby="host-form-terminal-scheme-hint"
            value={values.terminalScheme}
            inheritLabel={t("hosts.terminalSchemeInherit")}
            onValueChange={(terminalScheme) => setValues((v) => ({ ...v, terminalScheme }))}
          />
          <p id="host-form-terminal-scheme-hint" className="text-muted-foreground text-xs">
            {t("hosts.terminalSchemeHint")}
          </p>
        </div>
        {host && <ClearCredentialsButton hostId={host.id} />}
        {saveError && (
          <p role="alert" className="text-destructive text-xs">
            {saveError}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {t("hosts.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {t("hosts.save")}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
