import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { terminalColorSchemes, type TerminalColorScheme } from "@/theme/terminal-themes";

/** Select item value for "no scheme of its own" (Radix Select forbids an empty value). */
const INHERIT = "inherit";

interface TerminalSchemeSelectProps {
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  /** `undefined` is "same as the global setting", offered only when `inheritLabel` is set. */
  value: TerminalColorScheme | undefined;
  onValueChange(value: TerminalColorScheme | undefined): void;
  /** Adds a first option meaning "no scheme of its own" (a Host following the global scheme). */
  inheritLabel?: string;
}

/** Picks a Terminal colour scheme; used by the Host editor and the Settings page. */
export function TerminalSchemeSelect({
  id,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  value,
  onValueChange,
  inheritLabel,
}: TerminalSchemeSelectProps) {
  const { t } = useTranslation();
  return (
    <Select
      value={value ?? (inheritLabel ? INHERIT : "app")}
      onValueChange={(next) => onValueChange(terminalColorSchemes.find((scheme) => scheme === next))}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} aria-describedby={describedBy} aria-invalid={invalid} size="sm" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {inheritLabel && <SelectItem value={INHERIT}>{inheritLabel}</SelectItem>}
        {terminalColorSchemes.map((scheme) => (
          <SelectItem key={scheme} value={scheme}>
            {t(`terminal.schemes.${scheme}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
