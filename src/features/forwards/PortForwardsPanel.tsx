import { ArrowRight, ArrowRightLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConnectPromptDialog } from "@/features/connect/ConnectPromptDialog";
import { RowContextMenu, RowMoreMenu, type MenuEntry } from "@/features/hosts/RowMenu";
import { useHosts, hostsStore } from "@/features/hosts/hostsStore";
import { readCommandError, refusal, type CommandError, type ConnectPrompt, type PromptAnswer } from "@/lib/ipc/connect";
import type { ForwardId, ForwardStatus, ForwardType, PortForward } from "@/lib/ipc/forwards";
import type { Host } from "@/lib/ipc/hosts";
import { cn } from "@/lib/utils";
import {
  defaultBindAddress,
  describeForward,
  emptyForwardForm,
  forwardFormFrom,
  parseForwardForm,
  type ForwardFormError,
  type ForwardFormField,
  type ForwardFormResult,
  type ForwardFormValues,
} from "./forwardForm";
import { forwardsStore, statusOf, useForwards } from "./forwardsStore";

interface PendingPrompt {
  prompt: ConnectPrompt;
  resolve: (answer: PromptAnswer) => void;
}

/** Which rule the inline editor is open for: a new one, or an existing id. */
type Editing = { kind: "new" } | { kind: "edit"; id: ForwardId } | null;

interface PortForwardsPanelProps {
  /** The Host when the tab was opened; its rules are read live from the hosts store. */
  host: Host;
  /** Whether the tab is shown. A connect question asked while hidden waits until it is. */
  active?: boolean;
}

/**
 * A Host's Port forward rules: add and edit them inline, start and stop each, and see
 * whether it is running or why it failed.
 */
export function PortForwardsPanel({ host: opened, active = true }: PortForwardsPanelProps) {
  const { t } = useTranslation();
  const host = useHosts((s) => s.tree.hosts.find((h) => h.id === opened.id)) ?? opened;
  const states = useForwards((s) => s.states);
  const [editing, setEditing] = useState<Editing>(null);
  const [starting, setStarting] = useState<ReadonlySet<ForwardId>>(new Set());
  /** The last start error per rule, for copy that is more helpful than the backend's message. */
  const [startErrors, setStartErrors] = useState<Record<ForwardId, CommandError>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const pendingRef = useRef<PendingPrompt | null>(null);
  const show = useCallback((next: PendingPrompt | null) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  // Closing the tab mid-connect refuses the open question so the backend stops waiting.
  useEffect(
    () => () => {
      const open = pendingRef.current;
      if (open) open.resolve(refusal(open.prompt));
    },
    [],
  );

  const mark = (id: ForwardId, on: boolean) =>
    setStarting((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const start = async (rule: PortForward) => {
    mark(rule.id, true);
    setStartErrors((errors) => without(errors, rule.id));
    try {
      await forwardsStore
        .getState()
        .start(host.id, rule.id, (prompt) => new Promise((resolve) => show({ prompt, resolve })));
    } catch (e) {
      const error = readCommandError(e);
      if (error.kind !== "cancelled") setStartErrors((errors) => ({ ...errors, [rule.id]: error }));
    } finally {
      mark(rule.id, false);
    }
  };

  const stop = (rule: PortForward) => {
    setStartErrors((errors) => without(errors, rule.id));
    void forwardsStore.getState().stop(rule.id);
  };

  const remove = async (rule: PortForward) => {
    setActionError(null);
    try {
      await hostsStore.getState().deleteForward(host.id, rule.id);
      await forwardsStore.getState().stop(rule.id);
    } catch (e) {
      setActionError(t("forwards.actionFailed", { message: readCommandError(e).message }));
    }
  };

  const save = async (values: ForwardFormValues, id?: ForwardId) => {
    const result = parseForwardForm(values);
    if (!result.ok) return result;
    await hostsStore.getState().saveForward(host.id, result.draft, id);
    setEditing(null);
    return result;
  };

  return (
    <div className="text-foreground h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{t("forwards.title")}</h2>
            <p className="text-muted-foreground mt-0.5">{t("forwards.lead", { host: host.name })}</p>
          </div>
          {host.forwards.length > 0 && editing?.kind !== "new" && (
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => setEditing({ kind: "new" })}>
              <Plus aria-hidden />
              {t("forwards.add")}
            </Button>
          )}
        </div>

        {actionError && (
          <p role="alert" className="text-destructive mt-3 text-xs">
            {actionError}
          </p>
        )}

        {host.forwards.length === 0 && editing === null ? (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <ArrowRightLeft className="text-muted-foreground size-6" aria-hidden />
            <div className="space-y-1">
              <p className="font-medium">{t("forwards.emptyTitle")}</p>
              <p className="text-muted-foreground max-w-72 text-balance">{t("forwards.emptyBody")}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setEditing({ kind: "new" })}>
              {t("forwards.add")}
            </Button>
          </div>
        ) : (
          <ul aria-label={t("forwards.listLabel", { host: host.name })} className="mt-5 divide-y border-y">
            {host.forwards.map((rule) =>
              editing?.kind === "edit" && editing.id === rule.id ? (
                <li key={rule.id} className="py-3">
                  <ForwardForm
                    initial={forwardFormFrom(rule)}
                    running={statusOf({ states }, rule.id).state === "running"}
                    onSave={(values) => save(values, rule.id)}
                    onCancel={() => setEditing(null)}
                  />
                </li>
              ) : (
                <ForwardRow
                  key={rule.id}
                  rule={rule}
                  status={statusOf({ states }, rule.id)}
                  starting={starting.has(rule.id)}
                  startError={startErrors[rule.id]}
                  onStart={() => void start(rule)}
                  onStop={() => stop(rule)}
                  onEdit={() => setEditing({ kind: "edit", id: rule.id })}
                  onDelete={() => void remove(rule)}
                />
              ),
            )}
            {editing?.kind === "new" && (
              <li className="py-3">
                <ForwardForm
                  initial={emptyForwardForm("local")}
                  isNew
                  onSave={(values) => save(values)}
                  onCancel={() => setEditing(null)}
                />
              </li>
            )}
          </ul>
        )}
      </div>
      {pending && (
        <ConnectPromptDialog
          prompt={pending.prompt}
          open={active}
          onAnswer={(answer) => {
            show(null);
            pending.resolve(answer);
          }}
        />
      )}
    </div>
  );
}

interface ForwardRowProps {
  rule: PortForward;
  status: ForwardStatus;
  starting: boolean;
  startError?: CommandError;
  onStart(): void;
  onStop(): void;
  onEdit(): void;
  onDelete(): void;
}

function ForwardRow({ rule, status, starting, startError, onStart, onStop, onEdit, onDelete }: ForwardRowProps) {
  const { t } = useTranslation();
  const { from, to } = describeForward(rule);
  const name = rule.label || (to === null ? from : `${from} → ${to}`);
  const state = starting ? "starting" : status.state;
  const entries: MenuEntry[] = [
    { type: "item", label: t("forwards.edit"), icon: <Pencil />, onSelect: onEdit },
    { type: "separator" },
    { type: "item", label: t("forwards.delete"), icon: <Trash2 />, destructive: true, onSelect: onDelete },
  ];
  const failure = status.state === "failed" ? failureText(t, status.reason, startError) : null;

  return (
    <RowContextMenu entries={entries}>
      <li className="group py-2.5">
        <div className="flex items-center gap-3">
          <StateDot state={state} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="truncate font-medium">{rule.label || t(`forwards.kinds.${rule.type}`)}</span>
              <span className="text-muted-foreground shrink-0 text-xs">{t(`forwards.status.${state}`)}</span>
              {rule.autoStart && <span className="text-muted-foreground shrink-0 text-xs">{t("forwards.autoStartBadge")}</span>}
            </div>
            <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
              <span className="shrink-0">{t(`forwards.ends.${rule.type}`)}</span>
              <span className="truncate font-mono">{from}</span>
              {to !== null && (
                <>
                  <ArrowRight className="size-3 shrink-0" aria-label="→" />
                  <span className="truncate font-mono">{to}</span>
                </>
              )}
            </div>
          </div>
          {status.state === "running" ? (
            <Button variant="outline" size="xs" onClick={onStop}>
              {t("forwards.stop")}
            </Button>
          ) : (
            <Button variant="outline" size="xs" disabled={starting} onClick={onStart}>
              {t("forwards.start")}
            </Button>
          )}
          <RowMoreMenu entries={entries} label={t("forwards.moreActions", { name })} />
        </div>
        {failure && (
          <div role="alert" className="mt-1.5 flex items-start gap-2 pl-5">
            <p className="text-destructive min-w-0 flex-1 text-xs break-words">{failure}</p>
            <Button variant="ghost" size="xs" className="text-muted-foreground -my-0.5" onClick={onStop}>
              {t("forwards.dismiss")}
            </Button>
          </div>
        )}
      </li>
    </RowContextMenu>
  );
}

type T = ReturnType<typeof useTranslation>["t"];

/** Readable copy for a failure: specific advice where the cause is known, else the backend's reason. */
function failureText(t: T, reason: string, error?: CommandError): string {
  if (error?.kind === "portInUse" || error?.kind === "permissionDenied" || error?.kind === "remoteRefused") {
    return t(`forwards.startErrors.${error.kind}`, error.details ?? {});
  }
  return reason;
}

/** Green while running (it holds a live Connection), red when failed, hollow when stopped. */
function StateDot({ state }: { state: ForwardStatus["state"] | "starting" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        state === "running" && "bg-success",
        state === "starting" && "bg-warning",
        state === "failed" && "bg-destructive",
        state === "stopped" && "border-muted-foreground/50 border",
      )}
    />
  );
}

/** `record` without `key`. */
function without<V>(record: Record<string, V>, key: string): Record<string, V> {
  const rest = { ...record };
  delete rest[key];
  return rest;
}

const typeOptions: readonly ForwardType[] = ["local", "remote", "dynamic"];

type TextField = "label" | "bindPort" | "targetHost" | "targetPort" | "bindAddress";

/** The form's text fields for each kind, in order, with their copy; a dynamic forward has no target. */
const layouts = {
  local: [
    { field: "label", label: "forwards.fields.label" },
    { field: "bindPort", label: "forwards.fieldsByType.local.bindPort" },
    { field: "targetHost", label: "forwards.fieldsByType.local.targetHost", hint: "forwards.hints.local.targetHost" },
    { field: "targetPort", label: "forwards.fieldsByType.local.targetPort" },
    { field: "bindAddress", label: "forwards.fieldsByType.local.bindAddress", hint: "forwards.hints.local.bindAddress" },
  ],
  remote: [
    { field: "label", label: "forwards.fields.label" },
    { field: "bindPort", label: "forwards.fieldsByType.remote.bindPort" },
    { field: "targetHost", label: "forwards.fieldsByType.remote.targetHost", hint: "forwards.hints.remote.targetHost" },
    { field: "targetPort", label: "forwards.fieldsByType.remote.targetPort" },
    { field: "bindAddress", label: "forwards.fieldsByType.remote.bindAddress", hint: "forwards.hints.remote.bindAddress" },
  ],
  dynamic: [
    { field: "label", label: "forwards.fields.label" },
    { field: "bindPort", label: "forwards.fieldsByType.dynamic.bindPort" },
    { field: "bindAddress", label: "forwards.fieldsByType.dynamic.bindAddress", hint: "forwards.hints.dynamic.bindAddress" },
  ],
} as const satisfies Record<ForwardType, readonly { field: TextField; label: string; hint?: string }[]>;

const numeric = new Set<TextField>(["bindPort", "targetPort"]);

interface ForwardFormProps {
  initial: ForwardFormValues;
  /** A new rule: the kind can be chosen. */
  isNew?: boolean;
  /** Editing a running rule: say that changes apply on the next start. */
  running?: boolean;
  onSave(values: ForwardFormValues): Promise<ForwardFormResult>;
  onCancel(): void;
}

/** The inline editor for one Port forward of any kind. */
function ForwardForm({ initial, isNew = false, running = false, onSave, onCancel }: ForwardFormProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<ForwardFormField, ForwardFormError>>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { type } = values;

  return (
    <form
      className="grid gap-3"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        setSaveError(null);
        onSave(values).then(
          (result) => {
            setSaving(false);
            setErrors(result.ok ? {} : result.errors);
          },
          (e: unknown) => {
            setSaving(false);
            setSaveError(t("forwards.actionFailed", { message: readCommandError(e).message }));
          },
        );
      }}
    >
      <p className="text-sm font-semibold">{isNew ? t("forwards.newTitle") : t("forwards.editTitle")}</p>
      {isNew && (
        <div className="grid gap-1.5">
          <SegmentedControl
            label={t("forwards.fields.type")}
            value={type}
            options={typeOptions.map((value) => ({ value, label: t(`forwards.kinds.${value}`) }))}
            onChange={(next) => {
              setErrors({});
              setValues((v) => ({ ...v, type: next }));
            }}
          />
          <p className="text-muted-foreground text-xs">{t(`forwards.kindHints.${type}`)}</p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {layouts[type].map((layout) => {
          const field: TextField = layout.field;
          const id = `forward-form-${field}`;
          const error = field === "label" || field === "bindAddress" ? undefined : errors[field];
          const hint = "hint" in layout ? t(layout.hint) : null;
          const label = t(layout.label);
          return (
            <div key={field} className={cn("grid content-start gap-1.5", (field === "label" || hint) && "col-span-2")}>
              <Label htmlFor={id} className="text-xs">
                {label}
              </Label>
              <Input
                id={id}
                className={cn("h-8", field !== "label" && "font-mono")}
                value={values[field]}
                inputMode={numeric.has(field) ? "numeric" : undefined}
                placeholder={
                  field === "label"
                    ? t("forwards.labelPlaceholder")
                    : field === "bindAddress"
                      ? defaultBindAddress(type)
                      : undefined
                }
                autoFocus={field === "label"}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
                onChange={(event) => setValues((v) => ({ ...v, [field]: event.target.value }))}
              />
              {error ? (
                <p id={`${id}-error`} className="text-destructive text-xs">
                  {t(`forwards.errors.${error}`)}
                </p>
              ) : (
                hint && (
                  <p id={`${id}-hint`} className="text-muted-foreground text-xs">
                    {hint}
                  </p>
                )
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id="forward-form-autoStart"
          checked={values.autoStart}
          onCheckedChange={(checked) => setValues((v) => ({ ...v, autoStart: checked === true }))}
          className="mt-0.5"
        />
        <div className="grid gap-0.5">
          <Label htmlFor="forward-form-autoStart" className="text-xs">
            {t("forwards.fields.autoStart")}
          </Label>
          <p className="text-muted-foreground text-xs">{t("forwards.autoStartHint")}</p>
        </div>
      </div>
      {running && <p className="text-muted-foreground text-xs">{t("forwards.restartHint")}</p>}
      {saveError && (
        <p role="alert" className="text-destructive text-xs">
          {saveError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {t("forwards.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {t("forwards.save")}
        </Button>
      </div>
    </form>
  );
}
