import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/SegmentedControl";
import { useTerminalPrefs } from "@/features/terminal/terminal-prefs-context";
import { cursorStyles, terminalBellModes, terminalNumberFields, type TerminalPrefs, type TerminalTitleSource } from "@/features/terminal/terminal-prefs";
import { TerminalSchemeSelect } from "@/features/terminal/TerminalSchemeSelect";
import { showToast } from "@/features/toasts/toastStore";
import { readCommandError } from "@/lib/ipc/connect";
import { pickTerminalOutputDirectory } from "@/lib/ipc/terminal";
import { CommitField } from "./CommitField";
import { SettingRow } from "./SettingRow";
import { settingRows } from "./setting-rows";
import { TerminalHighlightingSettings } from "./terminal-highlighting-settings";
import { TerminalSchemeSettings } from "./terminal-scheme-settings";

type BooleanPref = "ligatures" | "cursorBlink" | "copyOnSelect" | "confirmMultilinePaste" | "shellIntegration" | "autoLog" | "inlineImages";

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

  const chooseOutputDirectory = async () => {
    try {
      const logDirectory = await pickTerminalOutputDirectory(t(settingRows.logDirectory.title));
      if (logDirectory !== null) updatePrefs({ logDirectory });
    } catch (error) {
      const { message } = readCommandError(error);
      showToast((translate) => translate("settings.terminal.logDirectory.failed", { message }), "error");
    }
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
        <CommitField
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
      <SettingRow setting={settingRows.rightClickPaste}>
        <SegmentedControl
          label={t(settingRows.rightClickPaste.title)}
          value={prefs.rightClickPaste ? "paste" : "menu"}
          options={[
            { value: "menu", label: t("settings.terminal.rightClickPaste.options.menu") },
            { value: "paste", label: t("settings.terminal.rightClickPaste.options.paste") },
          ]}
          onChange={(mode) => updatePrefs({ rightClickPaste: mode === "paste" })}
        />
      </SettingRow>
      {toggle("confirmMultilinePaste")}
      {toggle("shellIntegration")}
      {toggle("autoLog")}
      <SettingRow setting={settingRows.logDirectory}>
        <div className="flex min-w-0 max-w-72 flex-wrap items-center justify-end gap-2">
          <span className="text-muted-foreground w-full truncate text-right text-xs" title={prefs.logDirectory ?? undefined}>
            {prefs.logDirectory ?? t("settings.terminal.logDirectory.default")}
          </span>
          <Button variant="outline" size="sm" onClick={() => void chooseOutputDirectory()}>
            {t("settings.terminal.logDirectory.choose")}
          </Button>
          {prefs.logDirectory && (
            <Button variant="ghost" size="sm" onClick={() => updatePrefs({ logDirectory: null })}>
              {t("settings.terminal.logDirectory.reset")}
            </Button>
          )}
        </div>
      </SettingRow>
      {toggle("inlineImages")}
      <TerminalHighlightingSettings config={prefs.highlighting} updatePrefs={updatePrefs} />
    </>
  );
}
