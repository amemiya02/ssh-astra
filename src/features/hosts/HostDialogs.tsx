import { ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { ConnectErrorPanel } from "@/features/connect/ConnectErrorPanel";
import { ConnectPromptDialog } from "@/features/connect/ConnectPromptDialog";
import { ProxyFields } from "@/features/connect/ProxyFields";
import { inheritedProxyForm, type ProxyField } from "@/features/connect/proxy-form";
import { readCommandError, refusal, type CommandError, type ConnectPrompt, type PromptAnswer } from "@/lib/ipc/connect";
import type { testHostConnection } from "@/lib/ipc/connections";
import { hostIcons, isTemporaryHost, type Group, type Host, type HostDraft, type HostId, type TerminalBackspace, type TerminalCharset } from "@/lib/ipc/hosts";
import { cn } from "@/lib/utils";
import { ansiHues } from "@/theme/monogram-ink";
import { TerminalSchemeSelect } from "@/features/terminal/TerminalSchemeSelect";
import { useTerminalPrefs } from "@/features/terminal/terminal-prefs-context";
import { isTerminalColorScheme } from "@/theme/terminal-themes";
import { ClearCredentialsButton } from "./ClearCredentialsButton";
import { HostMonogram } from "./HostMonogram";
import { HostTagInput } from "./HostTagInput";
import { appendHostTag } from "./host-tags";
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

const fields: { field: Exclude<HostFormField, ProxyField>; inputMode?: "numeric" }[] = [
  { field: "name" },
  { field: "address" },
  { field: "port", inputMode: "numeric" },
  { field: "user" },
];

/** Sentinel for "no Jump host": Radix Select reserves the empty string for clearing. */
const NO_JUMP_HOST = "none";
const AUTOMATIC = "automatic";
const HOST_ICON_CHOICES = [AUTOMATIC, ...hostIcons] as const;
const HOST_COLOR_CHOICES = [AUTOMATIC, ...ansiHues] as const;

const advancedFieldIds = {
  terminalScheme: "host-form-terminal-scheme",
  defaultDirectory: "host-form-default-directory",
  keepaliveSeconds: "host-form-keepalive-seconds",
  proxyAddress: "host-form-proxy-address",
  proxyPort: "host-form-proxy-port",
  proxyUsername: "host-form-proxy-username",
  proxyCommand: "host-form-proxy-command",
};

type ConnectionTestState =
  | { status: "testing" }
  | { status: "succeeded"; values: HostFormValues }
  | { status: "failed"; values: HostFormValues; error: CommandError };

/** The Host editor creates a Host, edits one, or saves a Temporary Host. */
export function HostFormDialogContent({
  host,
  hosts,
  groupName,
  save,
  testConnection,
  redetectOs,
  onSaved,
  onCancel,
}: {
  host?: Host;
  /** Hosts that can be picked as the Jump host. */
  hosts: Host[];
  /** The current Group or, when creating a Host, the selected Group. */
  groupName?: string;
  save: (draft: HostDraft, id?: HostId) => Promise<Host>;
  testConnection: typeof testHostConnection;
  redetectOs: (id: HostId) => Promise<void>;
  onSaved: (host: Host) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { prefs: { importedSchemes } } = useTerminalPrefs();
  const temporary = host !== undefined && isTemporaryHost(host);
  const [values, setValues] = useState<HostFormValues>(() => {
    if (!host) return emptyHostForm;
    const initial = hostFormFrom(host, importedSchemes);
    return temporary ? { ...initial, name: "" } : initial;
  });
  const [tagInput, setTagInput] = useState("");
  const [errors, setErrors] = useState<Extract<HostFormResult, { ok: false }>["errors"]>({});
  const [saveError, setSaveError] = useState<{ message: string; field?: keyof typeof advancedFieldIds } | null>(null);
  const [saving, setSaving] = useState(false);
  const [osRequest, setOsRequest] = useState<"idle" | "requesting" | "failed">("idle");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [connectionTest, setConnectionTest] = useState<ConnectionTestState | null>(null);
  const [testPrompt, setTestPrompt] = useState<{ prompt: ConnectPrompt; answer(answer: PromptAnswer): void } | null>(null);
  const testAbort = useRef<AbortController | null>(null);
  const savingTemporaryHost = temporary && saving;
  const testing = connectionTest?.status === "testing";
  const result = connectionTest && connectionTest.status !== "testing" && connectionTest.values === values
    ? connectionTest : null;

  useEffect(() => () => testAbort.current?.abort(), []);

  useLayoutEffect(() => {
    const field = saveError?.field ?? Object.keys(advancedFieldIds).find(
      (field) => errors[field as HostFormField],
    ) as keyof typeof advancedFieldIds | undefined;
    if (field) document.getElementById(advancedFieldIds[field])?.focus();
  }, [errors, saveError]);

  const schemeError = saveError?.field === "terminalScheme";
  const directoryError = saveError?.field === "defaultDirectory";
  const saveErrorMessage = saveError && (
    <p id="host-form-save-error" role="alert" className="text-destructive text-xs">
      {saveError.message}
    </p>
  );

  const validate = (purpose: "save" | "test") => {
    const { terminalScheme } = values;
    const result = parseHostForm({
      ...values,
      tags: appendHostTag(values.tags, tagInput),
      terminalScheme: isTerminalColorScheme(terminalScheme, importedSchemes) ? terminalScheme : undefined,
    }, purpose);
    setErrors(result.ok ? {} : result.errors);
    if (result.ok) return result.draft;
    if (Object.keys(result.errors).some((field) => field in advancedFieldIds)) setAdvancedOpen(true);
  };

  const runTest = async () => {
    if (testAbort.current || saving) return;
    setConnectionTest(null);
    setSaveError(null);
    const draft = validate("test");
    if (!draft) return;

    const controller = new AbortController();
    const { signal } = controller;
    testAbort.current = controller;
    setConnectionTest({ status: "testing" });
    try {
      await testConnection(draft, host?.id, (prompt) => new Promise((resolve) => {
        if (signal.aborted) {
          resolve(refusal(prompt));
          return;
        }
        const cancel = () => resolve(refusal(prompt));
        signal.addEventListener("abort", cancel, { once: true });
        setTestPrompt({
          prompt,
          answer(answer) {
            signal.removeEventListener("abort", cancel);
            setTestPrompt(null);
            resolve(answer);
          },
        });
      }));
      if (!signal.aborted) setConnectionTest({ status: "succeeded", values });
    } catch (e: unknown) {
      if (!signal.aborted) setConnectionTest({ status: "failed", values, error: readCommandError(e) });
    } finally {
      testAbort.current = null;
    }
  };

  return (
    <DialogContent
      showCloseButton={false}
      className="max-h-[calc(100vh-2rem)] max-w-[calc(100%-2rem)] overflow-y-auto p-5 sm:max-w-120"
      onEscapeKeyDown={(event) => { if (savingTemporaryHost) event.preventDefault(); }}
      onInteractOutside={(event) => { if (savingTemporaryHost) event.preventDefault(); }}
    >
      <form
        className="grid gap-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (testAbort.current || saving) return;
          setSaveError(null);
          const draft = validate("save");
          if (!draft) return;
          setSaving(true);
          save(draft, host?.id).then(onSaved, (e: unknown) => {
            const error = readCommandError(e);
            const field = error.kind === "invalid" && error.details?.field;
            const advancedField = typeof field === "string" && Object.hasOwn(advancedFieldIds, field)
              ? field as keyof typeof advancedFieldIds : undefined;
            if (advancedField) setAdvancedOpen(true);
            let message = error.message;
            if (error.kind === "temporaryHostUnavailable") message = t("quickConnect.noLongerAvailable");
            if (error.kind === "duplicateHostId") message = t("quickConnect.alreadySaved");
            if (advancedField === "proxyAddress" || advancedField === "proxyPort" || advancedField === "proxyUsername" || advancedField === "proxyCommand") {
              setErrors({ [advancedField]: advancedField });
            } else {
              setSaveError({ message, field: advancedField });
            }
            setSaving(false);
          });
        }}
      >
        <DialogHeader>
          <DialogTitle>{t(temporary ? "quickConnect.saveAsHost" : host ? "hosts.edit" : "hosts.new")}</DialogTitle>
          <DialogDescription>{t(temporary ? "quickConnect.saveAsHostDescription" : host ? "hosts.editDescription" : "hosts.newDescription")}</DialogDescription>
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
          <HostTagInput
            hosts={hosts}
            tags={values.tags}
            value={tagInput}
            onInput={setTagInput}
            onChange={(tags) => setValues((current) => ({ ...current, tags }))}
          />
          <div className="grid gap-1.5">
            <Label htmlFor="host-form-icon" className="text-xs">{t("hosts.fields.icon")}</Label>
            <Select
              value={values.icon ?? AUTOMATIC}
              onValueChange={(value) => setValues((current) => ({
                ...current, icon: hostIcons.find((icon) => icon === value),
              }))}
            >
              <SelectTrigger id="host-form-icon" size="sm" className="w-full">
                <SelectValue>{t(`hosts.icons.${values.icon ?? AUTOMATIC}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {HOST_ICON_CHOICES.map((choice) => {
                  const label = t(`hosts.icons.${choice}`);
                  const icon = choice === AUTOMATIC ? undefined : choice;
                  return (
                    <SelectItem key={choice} value={choice} textValue={label}>
                      <HostMonogram host={{ id: host?.id ?? "", name: values.name, icon, color: values.color, detectedOs: host?.detectedOs }} />
                      {label}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {host && !temporary && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-muted-foreground text-xs" role="status">
                  {host.detectedOs
                    ? t("hosts.osDetection.result", {
                      system: host.detectedOs === "debian" || host.detectedOs === "unknown"
                        ? t(`hosts.osDetection.${host.detectedOs}`)
                        : t(`hosts.icons.${host.detectedOs}`),
                    })
                    : t("hosts.osDetection.pending")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={osRequest === "requesting"}
                  onClick={() => {
                    setOsRequest("requesting");
                    redetectOs(host.id).then(() => setOsRequest("idle"), () => setOsRequest("failed"));
                  }}
                >
                  {t("hosts.osDetection.redetect")}
                </Button>
                {osRequest === "failed" && <p role="alert" className="text-destructive text-xs">{t("hosts.osDetection.failed")}</p>}
              </div>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="host-form-color" className="text-xs">{t("hosts.fields.color")}</Label>
            <Select
              value={values.color ?? AUTOMATIC}
              onValueChange={(value) => setValues((current) => ({
                ...current, color: ansiHues.find((color) => color === value),
              }))}
            >
              <SelectTrigger id="host-form-color" size="sm" className="w-full">
                <SelectValue>{t(`hosts.colors.${values.color ?? AUTOMATIC}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {HOST_COLOR_CHOICES.map((choice) => {
                  const color = choice === AUTOMATIC ? undefined : choice;
                  const label = t(`hosts.colors.${choice}`);
                  return (
                    <SelectItem key={choice} value={choice} textValue={label}>
                      {(host || color) && (
                        <HostMonogram host={{ id: host?.id ?? "", name: values.name, icon: values.icon, color, detectedOs: host?.detectedOs }} />
                      )}
                      {label}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
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
                <ProxyFields
                  id="host-form-proxy"
                  values={values.proxy ?? inheritedProxyForm}
                  errors={errors}
                  onChange={(proxy) => setValues((v) => ({ ...v, proxy }))}
                />
                {values.jumpHost && <p className="text-muted-foreground text-xs">{t("proxy.jumpHint")}</p>}
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
                  importedSchemes={importedSchemes}
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
              {host && !temporary && <ClearCredentialsButton hostId={host.id} />}
            </div>
          </div>
        </div>
        {!saveError?.field && saveErrorMessage}
        {testing && <p role="status" className="text-muted-foreground text-xs">{t("hosts.connectionTest.testing")}</p>}
        {result?.status === "succeeded" && <p role="status" className="text-success text-xs">{t("hosts.connectionTest.succeeded")}</p>}
        {result?.status === "failed" && <div className="text-sm [&>*]:m-0"><ConnectErrorPanel error={result.error} /></div>}
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" className="sm:mr-auto" disabled={testing || saving} onClick={() => void runTest()}>
            {t("hosts.connectionTest.action")}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={savingTemporaryHost} onClick={onCancel}>
            {t("hosts.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={saving || testing}>
            {t("hosts.save")}
          </Button>
        </DialogFooter>
      </form>
      {testPrompt && <ConnectPromptDialog prompt={testPrompt.prompt} onAnswer={testPrompt.answer} open hideCredentialSaving />}
    </DialogContent>
  );
}
