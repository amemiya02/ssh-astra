import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
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
import type { Group, Host, HostDraft, HostId } from "@/lib/ipc/hosts";
import { cn } from "@/lib/utils";
import { TerminalSchemeSelect } from "@/features/terminal/TerminalSchemeSelect";
import { ClearCredentialsButton } from "./ClearCredentialsButton";
import { emptyHostForm, hostFormFrom, parseHostForm, type HostFormField, type HostFormResult, type HostFormValues } from "./hostForm";

export type Removal = { kind: "host"; host: Host } | { kind: "group"; group: Group };

/** Confirms deleting a Host or a Group. */
export function ConfirmRemoveDialogContent({
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
export function HostFormDialogContent({
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
        <div className="grid gap-1.5">
          <Label htmlFor="host-form-default-directory" className="text-xs">
            {t("hosts.fields.defaultDirectory")}
          </Label>
          <Input
            id="host-form-default-directory"
            className="h-8 font-mono"
            value={values.defaultDirectory ?? ""}
            placeholder="~"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby="host-form-default-directory-hint"
            onChange={(event) => setValues((v) => ({ ...v, defaultDirectory: event.target.value }))}
          />
          <p id="host-form-default-directory-hint" className="text-muted-foreground text-xs">
            {t("hosts.defaultDirectoryHint")}
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
