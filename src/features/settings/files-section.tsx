import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { filesSetting } from "@/features/files/file-prefs";
import { useSetting } from "@/lib/storage";
import { SettingRow } from "./SettingRow";

const columns = ["showModified", "showPermissions"] as const;

export function FilesSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useSetting(filesSetting);
  return columns.map((column) => {
    const label = t(`settings.files.${column}`);
    return (
      <SettingRow key={column} label={label}>
        <SegmentedControl
          label={label}
          value={settings[column] ? "on" : "off"}
          options={[
            { value: "on", label: t("settings.on") },
            { value: "off", label: t("settings.off") },
          ]}
          onChange={(value) => setSettings({ ...settings, [column]: value === "on" })}
        />
      </SettingRow>
    );
  });
}
