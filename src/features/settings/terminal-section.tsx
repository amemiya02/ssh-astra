import { useState, type ComponentProps, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Input } from "@/components/ui/input";
import { useTerminalPrefs } from "@/features/terminal/terminal-prefs-context";
import { maxFontSize, minFontSize, type TerminalPrefs } from "@/features/terminal/terminal-prefs";
import { TerminalSchemeSelect } from "@/features/terminal/TerminalSchemeSelect";
import { SettingRow } from "./SettingRow";

type BooleanPref = "ligatures" | "copyOnSelect" | "rightClickPaste" | "confirmMultilinePaste" | "shellIntegration";

/**
 * A text field that applies its value when it loses focus or on Enter, so a half-typed
 * font name or size never reaches the open Terminals. Escape puts the saved value back.
 */
function CommitField({
  id,
  label,
  value,
  onCommit,
  ...props
}: { id: string; label: string; value: string; onCommit(value: string): void } & Pick<
  ComponentProps<"input">,
  "type" | "min" | "max" | "step" | "className" | "inputMode"
>) {
  // What the user is typing; null shows the saved value (also after a commit, which may repair it).
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== value) onCommit(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commit();
    if (event.key === "Escape") setDraft(null);
  };

  return (
    <Input
      id={id}
      aria-label={label}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
      spellCheck={false}
      autoComplete="off"
      {...props}
    />
  );
}

export function TerminalSection() {
  const { t } = useTranslation();
  const { prefs, updatePrefs } = useTerminalPrefs();

  const toggle = (key: BooleanPref) => {
    const label = t(`settings.terminal.${key}.label`);
    return (
      <SettingRow key={key} label={label} description={t(`settings.terminal.${key}.description`)}>
        <SegmentedControl
          label={label}
          value={prefs[key] ? "on" : "off"}
          options={[
            { value: "on", label: t("settings.on") },
            { value: "off", label: t("settings.off") },
          ]}
          onChange={(next) => updatePrefs({ [key]: next === "on" } as Partial<TerminalPrefs>)}
        />
      </SettingRow>
    );
  };

  const fontLabel = t("settings.terminal.font.label");
  const sizeLabel = t("settings.terminal.fontSize.label");
  const schemeLabel = t("settings.terminal.colorScheme.label");

  return (
    <>
      <SettingRow label={fontLabel} description={t("settings.terminal.font.description")}>
        <CommitField
          id="settings-terminal-font"
          label={fontLabel}
          value={prefs.fontFamily}
          onCommit={(fontFamily) => updatePrefs({ fontFamily })}
          className="h-8 w-56 font-mono"
        />
      </SettingRow>
      <SettingRow
        label={sizeLabel}
        description={t("settings.terminal.fontSize.description", { min: minFontSize, max: maxFontSize })}
      >
        <CommitField
          id="settings-terminal-font-size"
          label={sizeLabel}
          type="number"
          inputMode="numeric"
          min={minFontSize}
          max={maxFontSize}
          step={1}
          value={String(prefs.fontSize)}
          onCommit={(raw) => {
            // An empty or non-numeric entry keeps the current size; the rest is clamped.
            const fontSize = Number(raw);
            if (raw.trim() && Number.isFinite(fontSize)) updatePrefs({ fontSize });
          }}
          className="h-8 w-20 tabular-nums"
        />
      </SettingRow>
      {toggle("ligatures")}
      <SettingRow label={schemeLabel} description={t("settings.terminal.colorScheme.description")}>
        <div className="w-56">
          <TerminalSchemeSelect
            id="settings-terminal-scheme"
            aria-label={schemeLabel}
            value={prefs.colorScheme}
            onValueChange={(colorScheme) => updatePrefs({ colorScheme: colorScheme ?? "app" })}
          />
        </div>
      </SettingRow>
      {toggle("copyOnSelect")}
      {toggle("rightClickPaste")}
      {toggle("confirmMultilinePaste")}
      {toggle("shellIntegration")}
    </>
  );
}
