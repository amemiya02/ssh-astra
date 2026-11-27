import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { CommandError } from "@/lib/ipc/connect";
import type { FileEntry } from "@/lib/ipc/files";
import type { FileBrowserStore } from "./fileBrowsers";
import { operationErrorText } from "./fileErrors";
import { nameProblem, octalMode, parseOctalMode } from "./fileList";

/** A file operation waiting for the user in a dialog. Names are entries of the directory shown. */
export type FileOperation =
  | { kind: "newFile" }
  | { kind: "newFolder" }
  | { kind: "delete"; names: string[] }
  | { kind: "permissions"; entry: FileEntry };

/** The dialog for `operation`, run on `store`; closes itself once the operation succeeds. */
export function FileOperationDialog({
  store,
  operation,
  onClose,
}: {
  store: FileBrowserStore;
  operation: FileOperation;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const entries = useStore(store, (s) => s.entries);
  const names = entries.map((e) => e.name);
  switch (operation.kind) {
    case "newFile":
    case "newFolder": {
      const folder = operation.kind === "newFolder";
      return (
        <NameDialog
          title={t(folder ? "files.newFolder" : "files.newFile")}
          existing={names}
          onSubmit={(name) => folder ? store.getState().createFolder(name) : store.getState().createFile(name)}
          onClose={onClose}
        />
      );
    }
    case "delete":
      return <DeleteDialog store={store} names={operation.names} onClose={onClose} />;
    case "permissions":
      return (
        <PermissionsDialog
          entry={operation.entry}
          onApply={(mode) => store.getState().setPermissions(operation.entry.name, mode)}
          onClose={onClose}
        />
      );
  }
}

/** Runs `run` once at a time, keeping the dialog open with the reason when it fails. */
function useOperation(onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<CommandError | null>(null);
  const run = async (operation: () => Promise<CommandError | null>) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await operation();
    setBusy(false);
    if (result === null) onClose();
    else setFailure(result);
  };
  return { busy, failure, run };
}

function Failure({ error }: { error: CommandError | null }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <p role="alert" className="text-destructive text-xs">
      {operationErrorText(t, error)}
    </p>
  );
}

function OperationDialog({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} className="max-w-[calc(100%-2rem)] gap-3 p-5 sm:max-w-100">
        <DialogHeader>
          <DialogTitle className="break-all">{title}</DialogTitle>
          {/* Radix wants a description; an empty one keeps screen readers quiet. */}
          <DialogDescription className={description ? undefined : "sr-only"}>{description ?? title}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** Asks for the name of a new entry. */
function NameDialog({
  title,
  existing,
  onSubmit,
  onClose,
}: {
  title: string;
  existing: readonly string[];
  onSubmit(name: string): Promise<CommandError | null>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const { busy, failure, run } = useOperation(onClose);
  const problem = nameProblem(name, existing);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (problem === null) void run(() => onSubmit(name));
  };

  return (
    <OperationDialog title={title} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Input
          aria-label={t("files.name")}
          value={name}
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-invalid={problem !== null && problem !== "empty"}
          onChange={(event) => setName(event.target.value)}
        />
        {problem !== null && problem !== "empty" && (
          <p className="text-destructive text-xs">{t(`files.nameProblem.${problem}`, { name })}</p>
        )}
        <Failure error={failure} />
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            {t("files.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={problem !== null || busy}>
            {t("files.create")}
          </Button>
        </DialogFooter>
      </form>
    </OperationDialog>
  );
}

/** Confirms a delete, saying how many entries (folders' contents included) will go. */
function DeleteDialog({ store, names, onClose }: { store: FileBrowserStore; names: string[]; onClose(): void }) {
  const { t } = useTranslation();
  const [count, setCount] = useState<number | null>(null);
  const [countFailure, setCountFailure] = useState<CommandError | null>(null);
  const { busy, failure, run } = useOperation(onClose);

  useEffect(() => {
    let live = true;
    void store
      .getState()
      .countForDelete(names)
      .then((result) => {
        if (!live) return;
        if ("count" in result) setCount(result.count);
        else setCountFailure(result.error);
      });
    return () => {
      live = false;
    };
  }, [store, names]);

  const title =
    names.length === 1 ? t("files.delete.titleOne", { name: names[0] }) : t("files.delete.titleMany", { count: names.length });
  return (
    <OperationDialog
      title={title}
      description={count === null ? t("files.delete.counting") : t("files.delete.count", { count })}
      onClose={onClose}
    >
      <Failure error={failure ?? countFailure} />
      <DialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          {t("files.cancel")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          autoFocus
          disabled={count === null || busy}
          onClick={() => void run(() => store.getState().remove(names))}
        >
          {t("files.delete.confirm")}
        </Button>
      </DialogFooter>
    </OperationDialog>
  );
}

const classes = [
  { key: "owner", shift: 6 },
  { key: "group", shift: 3 },
  { key: "others", shift: 0 },
] as const;
const rights = [
  { key: "read", bit: 4 },
  { key: "write", bit: 2 },
  { key: "execute", bit: 1 },
] as const;

/** Edits an entry's permission bits as checkboxes or as an octal number; the two stay in step. */
export function PermissionsDialog({
  entry,
  onApply,
  onClose,
}: {
  entry: FileEntry;
  onApply(mode: number): Promise<CommandError | null>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState(entry.permissions ?? 0o644);
  const [octal, setOctal] = useState(octalMode(entry.permissions ?? 0o644));
  const { busy, failure, run } = useOperation(onClose);
  const valid = parseOctalMode(octal) !== null;

  const toggle = (bit: number, on: boolean) => {
    const next = on ? mode | bit : mode & ~bit;
    setMode(next);
    setOctal(octalMode(next));
  };

  return (
    <OperationDialog title={t("files.permissions.title", { name: entry.name })} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) void run(() => onApply(mode));
        }}
      >
        <div role="group" className="grid grid-cols-[1fr_repeat(3,4rem)] items-center gap-y-2 text-sm">
          <span />
          {rights.map((right) => (
            <span key={right.key} className="text-muted-foreground text-center text-xs">
              {t(`files.permissions.${right.key}`)}
            </span>
          ))}
          {classes.map((who) => (
            <PermissionRow key={who.key} who={who} mode={mode} onToggle={toggle} />
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("files.permissions.octal")}</span>
          <Input
            aria-label={t("files.permissions.octal")}
            value={octal}
            className="h-8 w-20 font-mono"
            inputMode="numeric"
            aria-invalid={!valid}
            onChange={(event) => {
              setOctal(event.target.value);
              const parsed = parseOctalMode(event.target.value);
              if (parsed !== null) setMode(parsed);
            }}
          />
        </label>
        <Failure error={failure} />
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            {t("files.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={!valid || busy}>
            {t("files.permissions.apply")}
          </Button>
        </DialogFooter>
      </form>
    </OperationDialog>
  );
}

function PermissionRow({
  who,
  mode,
  onToggle,
}: {
  who: (typeof classes)[number];
  mode: number;
  onToggle(bit: number, on: boolean): void;
}) {
  const { t } = useTranslation();
  const whoLabel = t(`files.permissions.${who.key}`);
  return (
    <>
      <span>{whoLabel}</span>
      {rights.map((right) => {
        const bit = right.bit << who.shift;
        return (
          <span key={right.key} className="flex justify-center">
            <Checkbox
              aria-label={`${whoLabel} ${t(`files.permissions.${right.key}`).toLowerCase()}`}
              checked={(mode & bit) !== 0}
              onCheckedChange={(checked) => onToggle(bit, checked === true)}
            />
          </span>
        );
      })}
    </>
  );
}
