import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { isLongCommandThreshold, notificationCategories, notificationSetting } from "@/features/notifications/notification-settings";
import { useTerminalPrefs } from "@/features/terminal/terminal-prefs-context";
import { useSetting } from "@/lib/storage";
import { CommitField } from "./CommitField";
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
  const { prefs } = useTerminalPrefs();
  const thresholdRow = settingRows.longCommandThreshold;
  return notificationCategories.map((category) => (
    <Fragment key={category}>
      <SettingRow
        setting={rows[category]}
        description={category === "longCommand" && !prefs.shellIntegration
          ? t("settings.notifications.longCommand.shellIntegrationOff")
          : undefined}
      >
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
      {category === "longCommand" && (
        <SettingRow setting={thresholdRow} descriptionValues={{ seconds: notificationSetting.defaults.longCommandThresholdSeconds }}>
          <CommitField
            id="settings-long-command-threshold"
            label={t(thresholdRow.title)}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={String(settings.longCommandThresholdSeconds)}
            onCommit={(raw) => {
              const seconds = Number(raw);
              if (isLongCommandThreshold(seconds)) setSettings({ ...settings, longCommandThresholdSeconds: seconds });
            }}
            className="h-8 w-20 tabular-nums"
          />
        </SettingRow>
      )}
    </Fragment>
  ));
}
