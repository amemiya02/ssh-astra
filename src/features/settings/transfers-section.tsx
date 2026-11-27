import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { concurrencyChoices, transferSetting } from "@/features/transfers/transfer-settings";
import { useSetting } from "@/lib/storage";
import { SettingRow } from "./SettingRow";
import { settingRows } from "./setting-rows";

export function TransfersSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useSetting(transferSetting);
  const label = t(settingRows.concurrency.title);
  // A hand-edited value outside the choices still shows, as its own option.
  const choices = concurrencyChoices.some((n) => n === settings.concurrency)
    ? [...concurrencyChoices]
    : [...concurrencyChoices, settings.concurrency].sort((a, b) => a - b);
  const sleep = settingRows.preventTransferSleep;
  return (
    <>
      <SettingRow setting={settingRows.concurrency}>
        <SegmentedControl
          label={label}
          value={String(settings.concurrency)}
          options={choices.map((n) => ({ value: String(n), label: String(n) }))}
          onChange={(value) => setSettings({ ...settings, concurrency: Number(value) })}
        />
      </SettingRow>
      <SettingRow setting={sleep}>
        <SegmentedControl
          label={t(sleep.title)}
          value={settings.preventSleep ? "on" : "off"}
          options={[
            { value: "on", label: t("settings.on") },
            { value: "off", label: t("settings.off") },
          ]}
          onChange={(value) => setSettings({ ...settings, preventSleep: value === "on" })}
        />
      </SettingRow>
    </>
  );
}
