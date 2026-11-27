import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ProxyField, ProxyFormValues } from "./proxy-form";

const proxyFields = [
  { name: "address", field: "proxyAddress" },
  { name: "port", field: "proxyPort", inputMode: "numeric" },
  { name: "username", field: "proxyUsername" },
] as const;

export function ProxyFields({
  id,
  global,
  values,
  errors,
  onChange,
}: {
  id: string;
  global?: boolean;
  values: ProxyFormValues;
  errors: Partial<Record<ProxyField, string>>;
  onChange(values: ProxyFormValues): void;
}) {
  const { t } = useTranslation();
  const commandId = `${id}-command`;
  const custom = values.mode === "socks5" || values.mode === "httpConnect";
  return (
    <div className="grid gap-2.5">
      <div className="grid gap-1.5">
        <Label htmlFor={id} className="text-xs">{t("proxy.mode")}</Label>
        <Select
          value={values.mode}
          onValueChange={(mode: ProxyFormValues["mode"]) => onChange({ ...values, mode })}
        >
          <SelectTrigger id={id} size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {!global && <SelectItem value="inherit">{t("proxy.inherit")}</SelectItem>}
            <SelectItem value="direct">{t(global ? "proxy.none" : "proxy.direct")}</SelectItem>
            <SelectItem value="socks5">SOCKS5</SelectItem>
            <SelectItem value="httpConnect">HTTP CONNECT</SelectItem>
            {!global && <SelectItem value="proxyCommand">ProxyCommand</SelectItem>}
          </SelectContent>
        </Select>
      </div>
      {!global && values.mode === "proxyCommand" && (
        <div className="grid gap-1.5">
          <Label htmlFor={commandId} className="text-xs">{t("proxy.fields.command")}</Label>
          <textarea
            id={commandId}
            className="border-input focus-visible:border-ring focus-visible:ring-ring/50 min-h-12 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errors.proxyCommand ? true : undefined}
            aria-describedby={`${commandId}-hint${errors.proxyCommand ? ` ${commandId}-error` : ""}`}
            value={values.command ?? ""}
            onChange={(event) => onChange({ ...values, command: event.target.value })}
          />
          <p id={`${commandId}-hint`} className="text-muted-foreground text-xs">{t("proxy.commandHint")}</p>
          {errors.proxyCommand && <p id={`${commandId}-error`} className="text-destructive text-xs">{t("proxy.errors.proxyCommand")}</p>}
        </div>
      )}
      {custom && proxyFields.map((entry) => {
        const { field, name } = entry;
        const fieldId = `${id}-${name}`;
        const error = errors[field];
        const hint = name === "username" ? `${fieldId}-hint` : undefined;
        return (
          <div key={field} className="grid gap-1.5">
            <Label htmlFor={fieldId} className="text-xs">{t(`proxy.fields.${name}`)}</Label>
            <Input
              id={fieldId}
              className={name === "address" ? "h-8 font-mono" : "h-8"}
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              inputMode={"inputMode" in entry ? entry.inputMode : undefined}
              aria-invalid={error ? true : undefined}
              aria-describedby={[hint, error && `${fieldId}-error`].filter(Boolean).join(" ") || undefined}
              value={values[name]}
              onChange={(event) => onChange({ ...values, [name]: event.target.value })}
            />
            {hint && <p id={hint} className="text-muted-foreground text-xs">{t("proxy.passwordHint")}</p>}
            {error && <p id={`${fieldId}-error`} className="text-destructive text-xs">{t(`proxy.errors.${field}`)}</p>}
          </div>
        );
      })}
    </div>
  );
}
