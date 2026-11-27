import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { useTerminalPrefs } from "@/features/terminal/terminal-prefs-context";
import { cursorStyles, terminalBellModes, terminalNumberFields, type TerminalPrefs, type TerminalTitleSource } from "@/features/terminal/terminal-prefs";
import { TerminalSchemeSelect } from "@/features/terminal/TerminalSchemeSelect";
import { SettingRow } from "./SettingRow";
import { SettingTextField } from "./SettingTextField";
import { settingRows } from "./setting-rows";
import { TerminalHighlightingSettings } from "./terminal-highlighting-settings";
import { TerminalSchemeSettings } from "./terminal-scheme-settings";

type BooleanPref = "ligatures" | "cursorBlink" | "copyOnSelect" | "rightClickPaste" | "confirmMultilinePaste" | "shellIntegration";

export function TerminalSection() {
  const { t } = useTranslation();
  const { prefs, updatePrefs } = useTerminalPrefs();

  const toggle = (key: BooleanPref) => {
    const setting = settingRows[key];
    const label = t(setting.title);
    return (
      <SettingRow key={key} setting={setting}>
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
    const setting = settingRows[key];
    const label = t(setting.title);
    const { min, max, step } = terminalNumberFields[key];
    return (
      <SettingRow key={key} setting={setting} descriptionValues={{ min, max }}>
        <SettingTextField
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

  const fontLabel = t(settingRows.font.title);
  const schemeLabel = t(settingRows.colorScheme.title);
  const cursorLabel = t(settingRows.cursorStyle.title);
  const separatorLabel = t(settingRows.wordSeparator.title);
  const titleLabel = t(settingRows.titleSource.title);
  const bellLabel = t(settingRows.bell.title);

  return (
    <>
      <SettingRow setting={settingRows.font}>
        <SettingTextField
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
      <SettingRow setting={settingRows.colorScheme}>
        <div className="w-56">
          <TerminalSchemeSelect
            id="settings-terminal-scheme"
            aria-label={schemeLabel}
            value={prefs.colorScheme}
            importedSchemes={prefs.importedSchemes}
            onValueChange={(colorScheme) => updatePrefs({ colorScheme: colorScheme ?? "app" })}
          />
        </div>
      </SettingRow>
      <TerminalSchemeSettings importedSchemes={prefs.importedSchemes} updatePrefs={updatePrefs} />
      <SettingRow setting={settingRows.cursorStyle}>
        <SegmentedControl
          label={cursorLabel}
          value={prefs.cursorStyle}
          options={cursorStyles.map((value) => ({ value, label: t(`settings.terminal.cursorStyle.options.${value}`) }))}
          onChange={(cursorStyle) => updatePrefs({ cursorStyle })}
        />
      </SettingRow>
      {toggle("cursorBlink")}
      <SettingRow setting={settingRows.wordSeparator}>
        <SettingTextField
          id="settings-terminal-word-separator"
          label={separatorLabel}
          value={prefs.wordSeparator}
          onCommit={(wordSeparator) => updatePrefs({ wordSeparator })}
          className="h-8 w-56 font-mono"
        />
      </SettingRow>
      <SettingRow setting={settingRows.titleSource}>
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
      <SettingRow setting={settingRows.bell}>
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
