import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { generalSetting, languagePreferences } from "@/i18n/language";
import { useSetting } from "@/lib/storage";
import { useTheme } from "@/theme/theme-context";
import { interfaceZoom } from "@/theme/theme";
import { CommitField } from "./CommitField";
import { SettingRow } from "./SettingRow";
import { settingRows } from "./setting-rows";
import { useSettingRowVisible } from "./settings-view";
import { ThemeGallery } from "./theme-gallery";
import { WorkspaceSection } from "./workspace-section";

const zoomPresets = Array.from(
  { length: (interfaceZoom.max - interfaceZoom.min) / interfaceZoom.step + 1 },
  (_, index) => interfaceZoom.min + index * interfaceZoom.step,
);

function InterfaceZoomRow() {
  const { t } = useTranslation();
  const { settings, setZoom } = useTheme();
  const options = [...new Set([...zoomPresets, settings.zoom])].sort((a, b) => a - b);
  return (
    <SettingRow setting={settingRows.interfaceZoom}>
      <select
        aria-label={t(settingRows.interfaceZoom.title)}
        className="border-input bg-surface focus-visible:ring-ring/50 h-8 rounded-md border px-2 text-sm tabular-nums outline-none focus-visible:ring-[3px]"
        value={settings.zoom}
        onChange={(event) => setZoom(Number(event.target.value))}
      >
        {options.map((percent) => <option key={percent} value={percent}>{percent}%</option>)}
      </select>
    </SettingRow>
  );
}

function InterfaceFontRow() {
  const { t } = useTranslation();
  const { settings, setFontFamily } = useTheme();
  return (
    <SettingRow setting={settingRows.interfaceFont}>
      <CommitField
        id="settings-interface-font"
        label={t(settingRows.interfaceFont.title)}
        placeholder={t("settings.interfaceFont.system")}
        className="h-8 w-52 max-w-full"
        value={settings.fontFamily}
        onCommit={setFontFamily}
      />
    </SettingRow>
  );
}

export function AppearanceSection() {
  const { t } = useTranslation();
  const { settings, theme, setTheme } = useTheme();
  const label = t(settingRows.followAppearance.title);
  const showGallery = useSettingRowVisible(settingRows.themeGallery);
  const following = settings.theme === "system";
  return (
    <>
      <SettingRow setting={settingRows.followAppearance}>
        <SegmentedControl
          label={label}
          value={following ? "on" : "off"}
          options={[
            { value: "on", label: t("settings.on") },
            { value: "off", label: t("settings.off") },
          ]}
          // Turning it off keeps the theme being painted, so nothing changes until a card is picked.
          onChange={(next) => setTheme(next === "on" ? "system" : theme.id)}
        />
      </SettingRow>
      {showGallery && <ThemeGallery />}
    </>
  );
}

function LanguageSection() {
  const { t } = useTranslation();
  const [general, setGeneral] = useSetting(generalSetting);
  const label = t(settingRows.language.title);
  return (
    <SettingRow setting={settingRows.language}>
      <SegmentedControl
        label={label}
        value={general.language}
        options={languagePreferences.map((value) => ({ value, label: t(`settings.language.options.${value}`) }))}
        onChange={(language) => setGeneral({ ...general, language })}
      />
    </SettingRow>
  );
}

export function AppearanceCategory() {
  return (
    <>
      <InterfaceZoomRow />
      <InterfaceFontRow />
      <AppearanceSection />
      <WorkspaceSection />
      <LanguageSection />
    </>
  );
}
