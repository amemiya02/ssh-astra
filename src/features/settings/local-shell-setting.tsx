import { useTranslation } from "react-i18next";
import { useLocalShells } from "@/features/terminal/use-local-shells";
import { settingRows } from "./setting-rows";

export function LocalShellSetting({ value, onChange }: { value: string | null; onChange(value: string | null): void }) {
  const { t } = useTranslation();
  const shells = useLocalShells();
  const options = Array.isArray(shells) ? shells : [];
  const status = typeof shells === "string" ? t(`terminal.localShell.${shells}`) : undefined;
  const missing = value !== null && !options.some(({ id }) => id === value);

  return (
    <select
      aria-label={t(settingRows.localShell.title)}
      className="border-input bg-surface focus-visible:ring-ring h-8 w-56 min-w-0 rounded-md border px-2 text-sm outline-none focus-visible:ring-2"
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">{t("terminal.localShell.systemDefault")}</option>
      {missing && <option value={value} disabled>{status ?? t("terminal.localShell.unavailable")}</option>}
      {!missing && status && <option disabled>{status}</option>}
      {options.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
    </select>
  );
}
