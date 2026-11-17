import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { terminalColorSchemes, type TerminalColorScheme } from "@/theme/terminal-themes";

interface TerminalSchemeSelectProps extends Omit<ComponentProps<"select">, "value" | "onChange"> {
  /** `undefined` is "same as the global setting", offered only when `inheritLabel` is set. */
  value: TerminalColorScheme | undefined;
  onValueChange(value: TerminalColorScheme | undefined): void;
  /** Adds a first option meaning "no scheme of its own" (a Host following the global scheme). */
  inheritLabel?: string;
}

/** Picks a Terminal colour scheme; used by the Host editor and the Settings page. */
export function TerminalSchemeSelect({
  value,
  onValueChange,
  inheritLabel,
  className,
  ...props
}: TerminalSchemeSelectProps) {
  const { t } = useTranslation();
  return (
    <select
      className={cn(
        "border-input dark:bg-input/30 h-8 w-full rounded-md border bg-transparent px-2.5 text-sm outline-none",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        className,
      )}
      value={value ?? ""}
      onChange={(event) => {
        const next = terminalColorSchemes.find((scheme) => scheme === event.target.value);
        onValueChange(next);
      }}
      {...props}
    >
      {inheritLabel && <option value="">{inheritLabel}</option>}
      {terminalColorSchemes.map((scheme) => (
        <option key={scheme} value={scheme}>
          {t(`terminal.schemes.${scheme}`)}
        </option>
      ))}
    </select>
  );
}
