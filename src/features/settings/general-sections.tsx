import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { generalSetting, languagePreferences } from "@/i18n/language";
import { useSetting } from "@/lib/storage";
import { appearanceSetting, themePreferences } from "@/theme/theme";
import { SettingRow } from "./SettingRow";

export function AppearanceSection() {
  const { t } = useTranslation();
  const [appearance, setAppearance] = useSetting(appearanceSetting);
  const label = t("settings.theme.label");
  return (
    <SettingRow label={label} description={t("settings.theme.description")}>
      <SegmentedControl
        label={label}
        value={appearance.theme}
        options={themePreferences.map((value) => ({ value, label: t(`theme.${value}`) }))}
        onChange={(theme) => setAppearance({ ...appearance, theme })}
      />
    </SettingRow>
  );
}

export function LanguageSection() {
  const { t } = useTranslation();
  const [general, setGeneral] = useSetting(generalSetting);
  const label = t("settings.language.label");
  return (
    <SettingRow label={label} description={t("settings.language.description")}>
      <SegmentedControl
        label={label}
        value={general.language}
        options={languagePreferences.map((value) => ({ value, label: t(`settings.language.options.${value}`) }))}
        onChange={(language) => setGeneral({ ...general, language })}
      />
    </SettingRow>
  );
}
