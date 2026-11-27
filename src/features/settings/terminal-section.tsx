import { useState, type ComponentProps, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Input } from "@/components/ui/input";
import { useTerminalPrefs } from "@/features/terminal/terminal-prefs-context";
import { cursorStyles, terminalBellModes, terminalNumberFields, type TerminalPrefs, type TerminalTitleSource } from "@/features/terminal/terminal-prefs";
import { TerminalSchemeSelect } from "@/features/terminal/TerminalSchemeSelect";
import { SettingRow } from "./SettingRow";
import { TerminalHighlightingSettings } from "./terminal-highlighting-settings";

type BooleanPref = "ligatures" | "cursorBlink" | "copyOnSelect" | "rightClickPaste" | "confirmMultilinePaste" | "shellIntegration";

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

  const numberField = (key: keyof typeof terminalNumberFields) => {
    const label = t(`settings.terminal.${key}.label`);
    const { min, max, step } = terminalNumberFields[key];
    return (
      <SettingRow key={key} label={label} description={t(`settings.terminal.${key}.description`, { min, max })}>
        <CommitField
          id={`settings-terminal-${key}`}
          label={label}
          type="number"
          inputMode={key === "lineHeight" ? "decimal" : "numeric"}
          min={min}
          max={max}
          step={step}
          value={String(prefs[key])}
          onCommit={(raw) => {
            const value = Number(raw);
            if (raw.trim() && Number.isFinite(value)) updatePrefs({ [key]: value });
          }}
          className="h-8 w-20 tabular-nums"
        />
      </SettingRow>
    );
  };

  const fontLabel = t("settings.terminal.font.label");
  const schemeLabel = t("settings.terminal.colorScheme.label");
  const cursorLabel = t("settings.terminal.cursorStyle.label");
  const separatorLabel = t("settings.terminal.wordSeparator.label");
  const titleLabel = t("settings.terminal.titleSource.label");
  const bellLabel = t("settings.terminal.bell.label");

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
      {numberField("fontSize")}
      {numberField("fontWeight")}
      {numberField("lineHeight")}
      {numberField("letterSpacing")}
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
      <SettingRow label={cursorLabel} description={t("settings.terminal.cursorStyle.description")}>
        <SegmentedControl
          label={cursorLabel}
          value={prefs.cursorStyle}
          options={cursorStyles.map((value) => ({ value, label: t(`settings.terminal.cursorStyle.options.${value}`) }))}
          onChange={(cursorStyle) => updatePrefs({ cursorStyle })}
        />
      </SettingRow>
      {toggle("cursorBlink")}
      <SettingRow label={separatorLabel} description={t("settings.terminal.wordSeparator.description")}>
        <CommitField
          id="settings-terminal-word-separator"
          label={separatorLabel}
          value={prefs.wordSeparator}
          onCommit={(wordSeparator) => updatePrefs({ wordSeparator })}
          className="h-8 w-56 font-mono"
        />
      </SettingRow>
      <SettingRow label={titleLabel} description={t("settings.terminal.titleSource.description")}>
        <SegmentedControl<TerminalTitleSource>
          label={titleLabel}
          value={prefs.titleSource}
          options={[
            { value: "shell", label: t("settings.terminal.titleSource.options.shell") },
            { value: "host", label: t("settings.terminal.titleSource.options.host") },
          ]}
          onChange={(titleSource) => updatePrefs({ titleSource })}
        />
      </SettingRow>
      <SettingRow label={bellLabel} description={t("settings.terminal.bell.description")}>
        <SegmentedControl
          label={bellLabel}
          value={prefs.bell}
          options={terminalBellModes.map((value) => ({ value, label: t(`settings.terminal.bell.options.${value}`) }))}
          onChange={(bell) => updatePrefs({ bell })}
        />
      </SettingRow>
      {toggle("copyOnSelect")}
      {toggle("rightClickPaste")}
      {toggle("confirmMultilinePaste")}
      {toggle("shellIntegration")}
      <TerminalHighlightingSettings config={prefs.highlighting} updatePrefs={updatePrefs} />
    </>
  );
}
