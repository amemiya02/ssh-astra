import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { generalSetting, languagePreferences } from "@/i18n/language";
import { useSetting } from "@/lib/storage";
import { useTheme } from "@/theme/theme-context";
import { SettingRow } from "./SettingRow";
import { ThemeGallery } from "./theme-gallery";

export function AppearanceSection() {
  const { t } = useTranslation();
  const { settings, theme, setTheme } = useTheme();
  const label = t("settings.theme.follow.label");
  const following = settings.theme === "system";
  return (
    <>
      <SettingRow label={label} description={t("settings.theme.follow.description")}>
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
      <ThemeGallery />
    </>
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
