import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
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
import { readCommandError } from "@/lib/ipc/connect";
import { listHosts, saveHost, type Host } from "@/lib/ipc/hosts";
import { cn } from "@/lib/utils";
import { HostsSidebar } from "./HostsSidebar";
import { emptyHostForm, parseHostForm, type HostFormField, type HostFormResult, type HostFormValues } from "./hostForm";

interface HostsPanelProps {
  /** Open a remote Terminal on the Host. */
  onOpen(host: Host): void;
  onOpenLocalTerminal(): void;
}

/** The Host list in the sidebar, with a "New Host" dialog. Double-click (or Enter on) a Host to open it. */
export function HostsPanel({ onOpen, onOpenLocalTerminal }: HostsPanelProps) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    listHosts().then(setHosts, (e: unknown) => setLoadError(readCommandError(e).message));
  }, []);

  let list;
  if (loadError) {
    list = (
      <p role="alert" className="text-destructive px-1 py-2 text-xs">
        {loadError}
      </p>
    );
  } else if (hosts.length > 0) {
    list = (
      <ul aria-label={t("hosts.title")} className="grid gap-0.5">
        {hosts.map((host) => (
          <li key={host.id}>
            <HostRow
              host={host}
              selected={host.id === selectedId}
              onSelect={() => setSelectedId(host.id)}
              onOpen={() => onOpen(host)}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <HostsSidebar
        onOpenLocalTerminal={onOpenLocalTerminal}
        actions={
          <IconButton label={t("hosts.new")} onClick={() => setCreating(true)}>
            <Plus />
          </IconButton>
        }
      >
        {list}
      </HostsSidebar>
      <Dialog open={creating} onOpenChange={setCreating}>
        {creating && (
          <HostFormDialogContent
            onCancel={() => setCreating(false)}
            onSaved={(host) => {
              setHosts((all) => [...all, host]);
              setSelectedId(host.id);
              setCreating(false);
            }}
          />
        )}
      </Dialog>
    </>
  );
}

const initials = (name: string) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";

function HostRow({
  host,
  selected,
  onSelect,
  onOpen,
}: {
  host: Host;
  selected: boolean;
  onSelect(): void;
  onOpen(): void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      title={t("hosts.openHint")}
      aria-current={selected || undefined}
      className={cn(
        "focus-visible:ring-ring/50 flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-[3px]",
        selected ? "bg-selected" : "hover:bg-accent",
      )}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-6.5 shrink-0 place-items-center rounded-md text-xs font-semibold",
          selected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        {initials(host.name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{host.name}</span>
        <span className="text-muted-foreground block truncate text-xs">
          {host.user}@{host.address}
          {host.port === 22 ? "" : `:${host.port}`}
        </span>
      </span>
    </button>
  );
}

const fields: { field: HostFormField; inputMode?: "numeric" }[] = [
  { field: "name" },
  { field: "address" },
  { field: "port", inputMode: "numeric" },
  { field: "user" },
];

function HostFormDialogContent({ onSaved, onCancel }: { onSaved: (host: Host) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [values, setValues] = useState<HostFormValues>(emptyHostForm);
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
          saveHost(result.draft).then(onSaved, (e: unknown) => {
            setSaveError(readCommandError(e).message);
            setSaving(false);
          });
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("hosts.new")}</DialogTitle>
          <DialogDescription>{t("hosts.newDescription")}</DialogDescription>
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
          <select
            id="host-form-auth"
            className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-md border px-2 text-sm outline-none focus-visible:ring-[3px]"
            value={values.authType}
            onChange={(event) =>
              setValues((v) => ({ ...v, authType: event.target.value === "key" ? "key" : "password" }))
            }
          >
            <option value="password">{t("hosts.auth.password")}</option>
            <option value="key">{t("hosts.auth.key")}</option>
          </select>
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
