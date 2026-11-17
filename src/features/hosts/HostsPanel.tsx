import { Plus, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { readCommandError } from "@/lib/ipc/connect";
import { listHosts, saveHost, type Host } from "@/lib/ipc/hosts";
import { emptyHostForm, parseHostForm, type HostFormField, type HostFormResult, type HostFormValues } from "./hostForm";

/** The Host list with a minimal "new Host" form. Double-click a Host to open it. */
export function HostsPanel({ onOpen }: { onOpen: (host: Host) => void }) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    listHosts().then(setHosts, (e: unknown) => setLoadError(readCommandError(e).message));
  }, []);

  return (
    <nav aria-label={t("hosts.title")} className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <h2 className="text-sm font-semibold">{t("hosts.title")}</h2>
        <button
          type="button"
          className="text-muted-foreground hover:bg-accent hover:text-accent-foreground rounded-md p-1"
          aria-label={t("hosts.new")}
          title={t("hosts.new")}
          onClick={() => setCreating(true)}
        >
          <Plus className="size-4" aria-hidden />
        </button>
      </div>
      {creating && (
        <HostForm
          onCancel={() => setCreating(false)}
          onSaved={(host) => {
            setHosts((all) => [...all, host]);
            setCreating(false);
          }}
        />
      )}
      {loadError && (
        <p role="alert" className="text-destructive p-3 text-sm">
          {loadError}
        </p>
      )}
      <ul className="min-h-0 flex-1 overflow-y-auto p-1">
        {hosts.map((host) => (
          <li key={host.id}>
            <button
              type="button"
              className="hover:bg-accent focus-visible:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
              title={t("hosts.openHint")}
              onDoubleClick={() => onOpen(host)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onOpen(host);
              }}
            >
              <Server className="text-muted-foreground size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{host.name}</span>
                <span className="text-muted-foreground block truncate text-xs">
                  {host.user}@{host.address}
                  {host.port === 22 ? "" : `:${host.port}`}
                </span>
              </span>
            </button>
          </li>
        ))}
        {hosts.length === 0 && !creating && !loadError && (
          <li className="text-muted-foreground p-3 text-sm">{t("hosts.empty")}</li>
        )}
      </ul>
    </nav>
  );
}

const fields: { field: HostFormField; inputMode?: "numeric" }[] = [
  { field: "name" },
  { field: "address" },
  { field: "port", inputMode: "numeric" },
  { field: "user" },
];

function HostForm({ onSaved, onCancel }: { onSaved: (host: Host) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [values, setValues] = useState<HostFormValues>(emptyHostForm);
  const [errors, setErrors] = useState<Extract<HostFormResult, { ok: false }>["errors"]>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <form
      className="space-y-2 border-b p-3"
      aria-label={t("hosts.new")}
      onSubmit={(event) => {
        event.preventDefault();
        const result = parseHostForm(values);
        if (!result.ok) {
          setErrors(result.errors);
          return;
        }
        setErrors({});
        setSaving(true);
        saveHost(result.draft).then(onSaved, (e: unknown) => {
          setSaveError(readCommandError(e).message);
          setSaving(false);
        });
      }}
    >
      {fields.map(({ field, inputMode }) => (
        <label key={field} className="block text-xs">
          <span className="text-muted-foreground">{t(`hosts.fields.${field}`)}</span>
          <input
            className="bg-background focus-visible:outline-ring mt-0.5 w-full rounded-md border px-2 py-1 text-sm focus-visible:outline-2"
            value={values[field]}
            inputMode={inputMode}
            autoFocus={field === "name"}
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={errors[field] ? true : undefined}
            onChange={(event) => setValues((v) => ({ ...v, [field]: event.target.value }))}
          />
          {errors[field] && <span className="text-destructive">{t(`hosts.errors.${errors[field]}`)}</span>}
        </label>
      ))}
      <p className="text-muted-foreground text-xs">{t("hosts.passwordNote")}</p>
      {saveError && (
        <p role="alert" className="text-destructive text-xs">
          {saveError}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className="rounded-md border px-2.5 py-1 text-sm" onClick={onCancel}>
          {t("hosts.cancel")}
        </button>
        <button
          type="submit"
          disabled={saving}
          className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 text-sm disabled:opacity-50"
        >
          {t("hosts.save")}
        </button>
      </div>
    </form>
  );
}
