import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { connectionSetting, keepaliveChoices } from "@/features/connect/connection-settings";
import { useSetting } from "@/lib/storage";
import { SettingRow } from "./SettingRow";
import { settingRows } from "./setting-rows";

export function ConnectionSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useSetting(connectionSetting);
  const label = t(settingRows.keepalive.title);
  // A hand-edited value outside the choices still shows, as its own option.
  const choices = keepaliveChoices.some((s) => s === settings.keepaliveSeconds)
    ? [...keepaliveChoices]
    : [...keepaliveChoices, settings.keepaliveSeconds].sort((a, b) => a - b);
  return (
    <SettingRow setting={settingRows.keepalive}>
      <SegmentedControl
        label={label}
        value={String(settings.keepaliveSeconds)}
        options={choices.map((seconds) => ({
          value: String(seconds),
          label:
            seconds === 0
              ? t("settings.connection.keepalive.off")
              : t("settings.connection.keepalive.seconds", { count: seconds }),
        }))}
        onChange={(value) => setSettings({ ...settings, keepaliveSeconds: Number(value) })}
      />
    </SettingRow>
  );
}
