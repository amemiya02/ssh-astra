import { ChevronRight } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import type { Group, Host, HostDraft, HostId, TerminalBackspace, TerminalCharset } from "@/lib/ipc/hosts";
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

const advancedFieldIds = {
  terminalScheme: "host-form-terminal-scheme",
  defaultDirectory: "host-form-default-directory",
  keepaliveSeconds: "host-form-keepalive-seconds",
};

/** The Host editor: a new Host (`host` omitted) or edits to `host`. */
export function HostFormDialogContent({
  host,
  hosts,
  groupName,
  save,
  onSaved,
  onCancel,
}: {
  host?: Host;
  /** Hosts that can be picked as the Jump host. */
  hosts: Host[];
  /** The current Group or, when creating a Host, the selected Group. */
  groupName?: string;
  save: (draft: HostDraft, id?: HostId) => Promise<Host>;
  onSaved: (host: Host) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<HostFormValues>(() => (host ? hostFormFrom(host) : emptyHostForm));
  const [errors, setErrors] = useState<Extract<HostFormResult, { ok: false }>["errors"]>({});
  const [saveError, setSaveError] = useState<{ message: string; field?: keyof typeof advancedFieldIds } | null>(null);
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useLayoutEffect(() => {
    const field = saveError?.field ?? (errors.keepaliveSeconds ? "keepaliveSeconds" : undefined);
    if (field) document.getElementById(advancedFieldIds[field])?.focus();
  }, [errors, saveError]);

  const schemeError = saveError?.field === "terminalScheme";
  const directoryError = saveError?.field === "defaultDirectory";
  const saveErrorMessage = saveError && (
    <p id="host-form-save-error" role="alert" className="text-destructive text-xs">
      {saveError.message}
    </p>
  );

  return (
    <DialogContent
      showCloseButton={false}
      className="max-h-[calc(100vh-2rem)] max-w-[calc(100%-2rem)] overflow-y-auto p-5 sm:max-w-120"
    >
      <form
        className="grid gap-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          setSaveError(null);
          const result = parseHostForm(values);
          if (!result.ok) {
            setErrors(result.errors);
            if (result.errors.keepaliveSeconds) setAdvancedOpen(true);
            return;
          }
          setErrors({});
          setSaving(true);
          save(result.draft, host?.id).then(onSaved, (e: unknown) => {
            const error = readCommandError(e);
            const field = error.kind === "invalid" && error.details?.field;
            const advancedField = field === "terminalScheme" || field === "defaultDirectory" ? field : undefined;
            if (advancedField) setAdvancedOpen(true);
            setSaveError({ message: error.message, field: advancedField });
            setSaving(false);
          });
        }}
      >
        <DialogHeader>
          <DialogTitle>{host ? t("hosts.edit") : t("hosts.new")}</DialogTitle>
          <DialogDescription>{host ? t("hosts.editDescription") : t("hosts.newDescription")}</DialogDescription>
        </DialogHeader>
        <section aria-labelledby="host-form-basic" className="grid gap-3.5">
          <h3 id="host-form-basic" className="text-sm font-semibold">{t("hosts.basicInfo")}</h3>
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
              onValueChange={(value) => {
                if (value === "auto" || value === "password" || value === "key") {
                  setValues((v) => ({ ...v, authType: value }));
                }
              }}
            >
              <SelectTrigger id="host-form-auth" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("hosts.auth.auto")}</SelectItem>
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
          <dl className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
            <dt>{t("hosts.fields.group")}</dt>
            <dd className="text-muted-foreground break-all">{groupName ?? t("hosts.topLevel")}</dd>
          </dl>
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
        </section>
        <div className="border-t pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-between"
            aria-expanded={advancedOpen}
            aria-controls="host-form-advanced"
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            {t("hosts.advanced")}
            <ChevronRight aria-hidden="true" className={cn("text-muted-foreground", advancedOpen && "rotate-90")} />
          </Button>
          <div id="host-form-advanced" hidden={!advancedOpen}>
            <div className="grid gap-3.5 pt-2">
              <div className="flex items-start gap-2">
                <Checkbox
                  id="host-form-identities-only"
                  checked={values.identitiesOnly}
                  aria-describedby="host-form-identities-only-hint"
                  onCheckedChange={(checked) => setValues((v) => ({ ...v, identitiesOnly: checked === true }))}
                />
                <div className="grid gap-1.5">
                  <Label htmlFor="host-form-identities-only" className="text-xs">
                    {t("hosts.fields.identitiesOnly")}
                  </Label>
                  <p id="host-form-identities-only-hint" className="text-muted-foreground text-xs">
                    {t("hosts.identitiesOnlyHint")}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Checkbox
                  id="host-form-forward-agent"
                  checked={values.forwardAgent}
                  aria-describedby="host-form-forward-agent-hint"
                  onCheckedChange={(checked) => setValues((v) => ({ ...v, forwardAgent: checked === true }))}
                />
                <div className="grid gap-1.5">
                  <Label htmlFor="host-form-forward-agent" className="text-xs">
                    {t("hosts.fields.forwardAgent")}
                  </Label>
                  <p id="host-form-forward-agent-hint" className="text-muted-foreground text-xs">
                    {t("hosts.forwardAgentHint")}
                  </p>
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={advancedFieldIds.keepaliveSeconds} className="text-xs">
                  {t("hosts.fields.keepaliveSeconds")}
                </Label>
                <Input
                  id={advancedFieldIds.keepaliveSeconds}
                  className="h-8"
                  value={values.keepaliveSeconds ?? ""}
                  inputMode="numeric"
                  aria-invalid={errors.keepaliveSeconds ? true : undefined}
                  aria-describedby={errors.keepaliveSeconds ? "host-form-keepalive-hint host-form-keepalive-error" : "host-form-keepalive-hint"}
                  onChange={(event) => setValues((v) => ({ ...v, keepaliveSeconds: event.target.value }))}
                />
                <p id="host-form-keepalive-hint" className="text-muted-foreground text-xs">
                  {t("hosts.keepaliveHint")}
                </p>
                {errors.keepaliveSeconds && (
                  <p id="host-form-keepalive-error" className="text-destructive text-xs">
                    {t("hosts.errors.keepaliveSeconds")}
                  </p>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={advancedFieldIds.terminalScheme} className="text-xs">
                  {t("hosts.fields.terminalScheme")}
                </Label>
                <TerminalSchemeSelect
                  id={advancedFieldIds.terminalScheme}
                  aria-invalid={schemeError || undefined}
                  aria-describedby={schemeError ? "host-form-terminal-scheme-hint host-form-save-error" : "host-form-terminal-scheme-hint"}
                  value={values.terminalScheme}
                  inheritLabel={t("hosts.terminalSchemeInherit")}
                  onValueChange={(terminalScheme) => setValues((v) => ({ ...v, terminalScheme }))}
                />
                <p id="host-form-terminal-scheme-hint" className="text-muted-foreground text-xs">
                  {t("hosts.terminalSchemeHint")}
                </p>
                {schemeError && saveErrorMessage}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={advancedFieldIds.defaultDirectory} className="text-xs">
                  {t("hosts.fields.defaultDirectory")}
                </Label>
                <Input
                  id={advancedFieldIds.defaultDirectory}
                  className="h-8 font-mono"
                  value={values.defaultDirectory ?? ""}
                  placeholder="~"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={directoryError || undefined}
                  aria-describedby={directoryError ? "host-form-default-directory-hint host-form-save-error" : "host-form-default-directory-hint"}
                  onChange={(event) => setValues((v) => ({ ...v, defaultDirectory: event.target.value }))}
                />
                <p id="host-form-default-directory-hint" className="text-muted-foreground text-xs">
                  {t("hosts.defaultDirectoryHint")}
                </p>
                {directoryError && saveErrorMessage}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="host-form-post-login-command" className="text-xs">
                  {t("hosts.fields.postLoginCommand")}
                </Label>
                <Input
                  id="host-form-post-login-command"
                  className="h-8 font-mono"
                  value={values.postLoginCommand ?? ""}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-describedby="host-form-post-login-command-hint"
                  onChange={(event) => setValues((v) => ({ ...v, postLoginCommand: event.target.value }))}
                />
                <p id="host-form-post-login-command-hint" className="text-muted-foreground text-xs">
                  {t("hosts.postLoginCommandHint")}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3.5">
                <div className="grid gap-1.5">
                  <Label htmlFor="host-form-terminal-charset" className="text-xs">
                    {t("hosts.fields.terminalCharset")}
                  </Label>
                  <Select
                    value={values.terminalCharset}
                    onValueChange={(value) => setValues((v) => ({ ...v, terminalCharset: value as TerminalCharset }))}
                  >
                    <SelectTrigger id="host-form-terminal-charset" size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="utf8">UTF-8</SelectItem>
                      <SelectItem value="gbk">GBK</SelectItem>
                      <SelectItem value="big5">Big5</SelectItem>
                      <SelectItem value="latin1">Latin-1</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="host-form-terminal-backspace" className="text-xs">
                    {t("hosts.fields.terminalBackspace")}
                  </Label>
                  <Select
                    value={values.terminalBackspace}
                    onValueChange={(value) => setValues((v) => ({ ...v, terminalBackspace: value as TerminalBackspace }))}
                  >
                    <SelectTrigger id="host-form-terminal-backspace" size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="del">DEL</SelectItem>
                      <SelectItem value="ctrlH">Ctrl-H</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {host && <ClearCredentialsButton hostId={host.id} />}
            </div>
          </div>
        </div>
        {!saveError?.field && saveErrorMessage}
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
