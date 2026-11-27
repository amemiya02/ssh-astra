import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { filesSetting } from "@/features/files/file-prefs";
import { useTerminalPrefs } from "@/features/terminal/terminal-prefs-context";
import { useSetting } from "@/lib/storage";
import { SettingRow } from "./SettingRow";
import { settingRows } from "./setting-rows";

const toggles = ["showModified", "showPermissions", "terminalFollowsFilePanel"] as const;

export function FilesSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useSetting(filesSetting);
  const { prefs } = useTerminalPrefs();
  return toggles.map((key) => {
    const setting = settingRows[key];
    const label = t(setting.title);
    return (
      <SettingRow key={key} setting={setting}
        description={key === "terminalFollowsFilePanel" && !prefs.shellIntegration
          ? t("settings.files.terminalFollowsFilePanel.shellIntegrationOff")
          : undefined}
      >
        <SegmentedControl
          label={label}
          value={settings[key] ? "on" : "off"}
          options={[
            { value: "on", label: t("settings.on") },
            { value: "off", label: t("settings.off") },
          ]}
          onChange={(value) => setSettings({ ...settings, [key]: value === "on" })}
        />
      </SettingRow>
    );
  });
}
