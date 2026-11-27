import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { notificationCategories, notificationSetting } from "@/features/notifications/notification-settings";
import { useSetting } from "@/lib/storage";
import { SettingRow } from "./SettingRow";
import { settingRows } from "./setting-rows";

const rows = {
  transfers: settingRows.transferNotifications,
  reconnect: settingRows.reconnectNotifications,
  longCommand: settingRows.longCommandNotifications,
  terminal: settingRows.terminalNotifications,
};

export function NotificationsSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useSetting(notificationSetting);
  return notificationCategories.map((category) => (
    <SettingRow key={category} setting={rows[category]}>
      <SegmentedControl
        label={t(rows[category].title)}
        value={settings[category] ? "on" : "off"}
        options={[
          { value: "on", label: t("settings.on") },
          { value: "off", label: t("settings.off") },
        ]}
        onChange={(value) => setSettings({ ...settings, [category]: value === "on" })}
      />
    </SettingRow>
  ));
}
